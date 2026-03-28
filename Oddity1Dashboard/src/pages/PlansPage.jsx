import { useEffect, useRef, useState } from "react";
import AuthForm from "../components/AuthForm";
import { useProfile } from "../hooks/useProfile";
import { supabase } from "../lib/supabase";
import { BACKEND_URL } from "../utils/annotationConstants";
import "./PlansPage.css";

const INTERVALS = [
  { key: "month", label: "Monthly", price: "$10.99", period: "/mo", note: "" },
  {
    key: "quarter",
    label: "Quarterly",
    price: "$9.99",
    period: "/mo",
    note: "Billed $29.97 every 3 months",
  },
  {
    key: "year",
    label: "Annual",
    price: "$8.99",
    period: "/mo",
    note: "Billed $107.88 per year",
  },
];

const FREE_FEATURES = [
  "Up to 100 pages/month",
  "Overview & Depth annotations",
  "Terry & Jerry personalities",
  "PDF export (basic)",
];

const STANDARD_FEATURES = [
  "Up to 2,000 pages/month",
  "Everything in Free +",
  "Sally personality",
  "PDF annotation",
  "Custom PDF subtitles",
  "Structured arguments (Sketch Pad)",
];

function CheckIcon() {
  return (
    <svg
      className="plan-feature-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}

export default function PlansPage({ session }) {
  const { profile } = useProfile(session);
  const tier = profile?.tier || "free";

  const [interval, setInterval] = useState("month");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const pendingCheckout = useRef(false);
  // Store the interval at the moment Subscribe was clicked, so it survives
  // auth modal interactions and Google OAuth page reloads.
  const pendingInterval = useRef("month");

  const selected = INTERVALS.find((i) => i.key === interval);

  // On mount: check if a pending checkout was stored before a Google OAuth redirect
  useEffect(() => {
    const stored = localStorage.getItem("pending_checkout_interval");
    if (stored && session) {
      localStorage.removeItem("pending_checkout_interval");
      pendingInterval.current = stored;
      handleCheckout(session, stored);
    }
  }, [session]);

  // When auth modal succeeds and session appears, proceed with checkout
  useEffect(() => {
    if (session && pendingCheckout.current) {
      pendingCheckout.current = false;
      setShowAuthModal(false);
      handleCheckout(session, pendingInterval.current);
    }
  }, [session]);

  async function handleCheckout(activeSession, checkoutInterval) {
    const s = activeSession || session;
    const selectedInterval = checkoutInterval || interval;
    if (tier === "standard") {
      window.location.href = "/settings";
      return;
    }
    if (!s) {
      pendingCheckout.current = true;
      pendingInterval.current = interval;
      // Persist for Google OAuth redirects (page reload loses ref state)
      localStorage.setItem("pending_checkout_interval", interval);
      setShowAuthModal(true);
      return;
    }

    setCheckoutLoading(true);
    try {
      // Always get a fresh token — never fall back to a potentially stale one
      let { data: { session: freshSession } } = await supabase.auth.getSession();
      if (!freshSession?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        freshSession = refreshed.session;
      }
      const token = freshSession?.access_token;
      if (!token) {
        // Session truly expired — re-show auth modal so user can sign in again
        pendingCheckout.current = true;
        pendingInterval.current = selectedInterval;
        localStorage.setItem("pending_checkout_interval", selectedInterval);
        setCheckoutLoading(false);
        setShowAuthModal(true);
        return;
      }

      const res = await fetch(`${BACKEND_URL}/api/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ interval: selectedInterval }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Checkout failed");
      }

      const { url } = await res.json();
      // Only remove localStorage after we have a successful Stripe URL
      localStorage.removeItem("pending_checkout_interval");
      window.location.href = url;
    } catch (err) {
      console.error("[Plans] Checkout error:", err);
      setCheckoutLoading(false);
    }
  }

  function handleSubscribeClick() {
    handleCheckout(session, interval);
  }

  return (
    <div className="plans-page">
      <div className="plans-header">
        <h1 className="plans-title">Choose your plan</h1>
        <p className="plans-subtitle">
          Get more out of Oddity 1 with a Standard plan.
        </p>
      </div>

      {/* Interval toggle */}
      <div className="plans-interval-toggle">
        <div className="pill-group">
          {INTERVALS.map((i) => (
            <button
              key={i.key}
              className={`pill ${interval === i.key ? "pill--active" : ""}`}
              onClick={() => setInterval(i.key)}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="plans-grid">
        {/* Free plan */}
        <div className="plan-card">
          <div className="plan-name">Free</div>
          <div className="plan-price">
            <span className="plan-price-amount">$0</span>
            <span className="plan-price-period">/mo</span>
          </div>
          <div className="plan-price-note">Free forever</div>
          <a
            href="https://chromewebstore.google.com"
            target="_blank"
            rel="noopener noreferrer"
            className="plan-cta plan-cta--secondary"
          >
            Get Started
          </a>
          <ul className="plan-features">
            {FREE_FEATURES.map((f) => (
              <li key={f} className="plan-feature">
                <CheckIcon />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Standard plan */}
        <div className="plan-card plan-card--highlighted">
          <span className="plan-badge">Most Popular</span>
          <div className="plan-name">Standard</div>
          <div className="plan-price">
            <span className="plan-price-amount">{selected.price}</span>
            <span className="plan-price-period">{selected.period}</span>
          </div>
          <div className="plan-price-note">{selected.note || "\u00A0"}</div>
          <button
            className="plan-cta plan-cta--primary"
            onClick={handleSubscribeClick}
            disabled={checkoutLoading || tier === "standard"}
          >
            {tier === "standard" ? "Current Plan" : checkoutLoading ? "Redirecting..." : "Subscribe"}
          </button>
          <ul className="plan-features">
            {STANDARD_FEATURES.map((f) => (
              <li key={f} className="plan-feature">
                <CheckIcon />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Auth modal */}
      {showAuthModal && (
        <div
          className="plans-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowAuthModal(false);
              pendingCheckout.current = false;
              localStorage.removeItem("pending_checkout_interval");
            }
          }}
        >
          <div className="plans-modal-container">
            <button
              className="plans-modal-close"
              onClick={() => {
                setShowAuthModal(false);
                pendingCheckout.current = false;
                localStorage.removeItem("pending_checkout_interval");
              }}
              aria-label="Close"
            >
              &times;
            </button>
            <AuthForm
              modal
              onSuccess={(s) => {
                setShowAuthModal(false);
                handleCheckout(s, pendingInterval.current);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
