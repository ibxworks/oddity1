import { Link, NavLink, Outlet } from "react-router-dom";
import { useProfile } from "../hooks/useProfile";
import { supabase } from "../lib/supabase";

export default function Layout({ session }) {
  const { profile } = useProfile(session);
  const tier = profile?.tier || "free";

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-top">
          <a
            href="https://oddity1.com"
            className="sidebar-logo-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              src="/Oddity1-Logo.png"
              alt="Oddity1"
              className="sidebar-logo-img"
            />
          </a>
          <span className={`sidebar-tier sidebar-tier--${tier}`}>
            {tier.toUpperCase()}
          </span>
        </div>

        <a
          href="https://chromewebstore.google.com/detail/oddity1/khcpcihcakkkbglfaegenmlabkghaeea?utm_source=item-share-cb"
          className="sidebar-get-extension"
          target="_blank"
          rel="noopener noreferrer"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Get Oddity1
        </a>

        <nav className="sidebar-nav">
          <NavLink
            to="/archive"
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link--active" : ""}`
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Archive
          </NavLink>
          <NavLink
            to="/documents"
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link--active" : ""}`
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            Documents
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link--active" : ""}`
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Settings
          </NavLink>
          <NavLink
            to="/feedback"
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link--active" : ""}`
            }
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Send Feedback
          </NavLink>
        </nav>

        <div className="sidebar-bottom">
          {tier === "free" && (
            <Link to="/plans" className="sidebar-upgrade">
              Upgrade to Standard
            </Link>
          )}
          <div className="sidebar-user-section">
            <span className="sidebar-email">{session.user.email}</span>
            <button onClick={handleSignOut} className="sidebar-signout">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <Outlet context={{ session, profile }} />
      </main>
    </div>
  );
}
