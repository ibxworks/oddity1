import { useEffect, useRef, useState } from "react";
import AuthForm from "../components/AuthForm";
import { useProfile } from "../hooks/useProfile";
import { supabase } from "../lib/supabase";
import { BACKEND_URL } from "../utils/annotationConstants";
import "./PlansPage.css";

const FREE_FEATURES = [
  "Access to Terry and Jerry annotation styles",
  "Create and save your own annotations",
  "Export annotated webpages to PDF",
  "Limited monthly annotations",
];

const STANDARD_FEATURES = [
  "Everything in Free",
  "20x higher annotation limits than Free",
  "Advanced AI annotations",
  "Annotate PDFs",
  "Turn your annotations into structured arguments",
  "Full access to all annotation styles: Terry, Jerry, and Sally",
];

// Fallback while prices load or if fetch fails
const FALLBACK_BILLING = [
  { id: "yearly", label: "Yearly", price: "8.99", interval: "year" },
  { id: "quarterly", label: "Quarterly", price: "9.99", interval: "quarter" },
  { id: "monthly", label: "Monthly", price: "10.99", interval: "month" },
];

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5 6 8l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function PlansPage({ session }) {
  const { profile } = useProfile(session);
  const tier = profile?.tier || "free";

  // Billing options fetched from Stripe
  const [billingOptions, setBillingOptions] = useState(FALLBACK_BILLING);
  const [pricesLoaded, setPricesLoaded] = useState(false);

  const [interval, setInterval] = useState("yearly");
  const [billingMenuOpen, setBillingMenuOpen] = useState(false);
  const billingRef = useRef(null);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const pendingCheckout = useRef(false);
  const pendingInterval = useRef("year");

  const [scrolled, setScrolled] = useState(false);

  const activeBilling =
    billingOptions.find((o) => o.id === interval) ?? billingOptions[0];

  // Fetch prices from Stripe on mount
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/prices`)
      .then((r) => r.json())
      .then((data) => {
        if (data.prices?.length) {
          setBillingOptions(data.prices);
        }
        setPricesLoaded(true);
      })
      .catch(() => setPricesLoaded(true));
  }, []);

  // Scroll listener for navbar glass effect
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Click-outside to close billing dropdown
  useEffect(() => {
    function handler(e) {
      if (!billingRef.current?.contains(e.target)) setBillingMenuOpen(false);
    }
    function escHandler(e) {
      if (e.key === "Escape") setBillingMenuOpen(false);
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, []);

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
    const selectedInterval = checkoutInterval || activeBilling.interval;
    if (tier === "standard") {
      window.location.href = "/settings";
      return;
    }
    if (!s) {
      pendingCheckout.current = true;
      pendingInterval.current = activeBilling.interval;
      localStorage.setItem("pending_checkout_interval", activeBilling.interval);
      setShowAuthModal(true);
      return;
    }

    setCheckoutLoading(true);
    try {
      let {
        data: { session: freshSession },
      } = await supabase.auth.getSession();
      if (!freshSession?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        freshSession = refreshed.session;
      }
      const token = freshSession?.access_token;
      if (!token) {
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
      localStorage.removeItem("pending_checkout_interval");
      window.location.href = url;
    } catch (err) {
      console.error("[Plans] Checkout error:", err);
      setCheckoutLoading(false);
    }
  }

  return (
    <main className="plans-page">
      {/* ── Navbar ── */}
      <div className={`plans-nav-wrapper${scrolled ? " scrolled" : ""}`}>
        <nav className="plans-nav">
          <div className="nav-left">
            <a className="nav-logo" href="https://oddity1.com">
              Oddity<sup>1</sup>
            </a>
          </div>
          <ul className="nav-links">
            <li>
              <a href="https://oddity1.com/#what-it-is">Product</a>
            </li>
            <li>
              <a href="https://oddity1.com/#how">Features</a>
            </li>
            <li>
              <a href="/plans">Pricing</a>
            </li>
            <li>
              <a href="https://oddity1.com/about">About</a>
            </li>
          </ul>
          <div className="nav-right">
            <a className="nav-signin" href="/archive">
              Dashboard
            </a>
            <a
              className="nav-cta"
              href="https://chromewebstore.google.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download Extension
            </a>
          </div>
        </nav>
      </div>

      {/* ── Pricing Section ── */}
      <section className="pricing-section">
        <div className="container">
          <div style={{ textAlign: "center" }}>
            <p className="eyebrow">Pricing</p>
            <h2 className="section-h">Start free. Think sharper.</h2>
          </div>

          <div className="pricing-grid">
            {/* Free Card */}
            <div className="price-card">
              <div className="price-tier">Free</div>
              <div className="price-topline price-topline--simple">
                <div className="price-amount">$0</div>
              </div>
              <div className="price-desc">
                Your personal critical thinking companion.
              </div>
              <div className="price-rule" />
              <ul className="price-feats">
                {FREE_FEATURES.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <a
                className="price-btn"
                href="https://chromewebstore.google.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Get Chrome Extension
              </a>
            </div>

            {/* Standard Card (hot) */}
            <div className="price-card hot">
              <div className="price-tier">Standard</div>
              <div className="price-topline">
                <div className="price-amount">
                  <sup>$</sup>
                  {activeBilling.price}
                  <sub>/mo</sub>
                </div>
                <div className="price-period-picker" ref={billingRef}>
                  <button
                    type="button"
                    className={`price-period-trigger${billingMenuOpen ? " is-open" : ""}`}
                    aria-haspopup="menu"
                    aria-expanded={billingMenuOpen}
                    onClick={() => setBillingMenuOpen((o) => !o)}
                  >
                    <span>{activeBilling.label}</span>
                    <ChevronDown />
                  </button>
                  {billingMenuOpen && (
                    <div className="price-period-menu">
                      {billingOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`price-period-option${opt.id === interval ? " is-active" : ""}`}
                          onClick={() => {
                            setInterval(opt.id);
                            setBillingMenuOpen(false);
                          }}
                        >
                          <span>{opt.label}</span>
                          <span className="price-period-option-price">
                            ${opt.price}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="price-desc">
                Everything you need to think at a higher level.
              </div>
              <div className="price-rule" />
              <ul className="price-feats">
                {STANDARD_FEATURES.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <button
                className="price-btn"
                disabled={checkoutLoading || tier === "standard"}
                onClick={() => handleCheckout(session, activeBilling.interval)}
              >
                {tier === "standard"
                  ? "Current Plan"
                  : checkoutLoading
                    ? "Redirecting…"
                    : "Get Started"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="plans-footer">
        <div className="footer-inner">
          <div className="footer-main">
            <div className="footer-brand">
              <div className="footer-logo">
                Oddity<sup>1</sup>
              </div>
              <a className="footer-email" href="mailto:hello@oddity1.com">
                hello@oddity1.com
              </a>
            </div>
            <div className="footer-links">
              <div className="footer-col">
                <div className="footer-col-title">Company</div>
                <a href="https://oddity1.com/about">About</a>
                <a href="https://oddity1.com/blog">Blog</a>
                <a href="https://oddity1.com/terms">Terms</a>
                <a href="https://oddity1.com/privacy">Privacy Policy</a>
              </div>
              <div className="footer-col">
                <div className="footer-col-title">Connect</div>
                <a
                  href="https://x.com/TryOddity1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  X (Twitter)
                </a>
                <a
                  href="https://www.linkedin.com/company/oddity1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  LinkedIn
                </a>
                <a
                  href="https://www.instagram.com/tryoddity1/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Instagram
                </a>
              </div>
            </div>
          </div>
          <div className="footer-copy">
            © 2026 I Build X, Inc. All rights reserved.
          </div>
        </div>
      </footer>

      {/* ── Auth Modal ── */}
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
    </main>
  );
}
