import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useToast } from "../context/ToastContext";
import { supabase } from "../lib/supabase";
import { BACKEND_URL } from "../utils/annotationConstants";
import "./FeedbackPage.css";

const ROLE_OPTIONS = [
  "Student",
  "Researcher",
  "Teacher/Professor",
  "Engineer",
  "Designer",
  "Writer",
  "Product Manager",
];

export default function FeedbackPage() {
  const { session } = useOutletContext();
  const showToast = useToast();

  const [role, setRole] = useState("");
  const [otherRole, setOtherRole] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!message.trim()) return;

    const resolvedRole =
      role === "Other" ? otherRole.trim() : role;

    setSending(true);
    try {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();

      const res = await fetch(`${BACKEND_URL}/api/user-feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({
          message: message.trim(),
          role: resolvedRole || undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to send feedback");
      }

      showToast("Feedback sent! Thank you.");
      setMessage("");
      setRole("");
      setOtherRole("");
    } catch (err) {
      showToast(err.message || "Failed to send feedback");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="feedback-page">
      <div className="page-header">
        <h1 className="page-title">Send Feedback</h1>
      </div>

      <div className="feedback-body">
        <div className="card">
          <div className="card-title">We'd love to hear from you</div>

          <div className="field">
            <label className="field-label">Email</label>
            <div className="feedback-email-display">
              {session.user.email}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="feedback-role">
              Role (optional)
            </label>
            <select
              id="feedback-role"
              className="feedback-select"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                if (e.target.value !== "Other") setOtherRole("");
              }}
            >
              <option value="">Select your role...</option>
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value="Other">Other</option>
            </select>
            {role === "Other" && (
              <input
                type="text"
                className="feedback-other-input"
                placeholder="Your role..."
                value={otherRole}
                onChange={(e) => setOtherRole(e.target.value)}
              />
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="feedback-message">
              Message
            </label>
            <textarea
              id="feedback-message"
              className="feedback-textarea"
              placeholder="What's on your mind?"
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <button
            className="btn btn--primary feedback-send-btn"
            onClick={handleSend}
            disabled={sending || !message.trim()}
          >
            {sending ? "Sending..." : "Send Feedback"}
          </button>
        </div>
      </div>
    </div>
  );
}
