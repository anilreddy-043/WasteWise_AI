import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  Check,
  Leaf,
  Menu,
  Recycle,
  Sparkles,
  Store,
  Tag,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { StoreIllustration } from "./AuthPage";

type LandingPageProps = {
  onNavigate: (path: "/signin" | "/signup") => void;
};

const features = [
  { icon: Store, title: "Smart Inventory", text: "Track stock levels in real time and avoid overstocking.", color: "green" },
  { icon: BarChart3, title: "AI Predictions", text: "Forecast demand and identify waste risks early.", color: "blue" },
  { icon: Tag, title: "Smart Discounts", text: "Get AI-powered discount recommendations.", color: "orange" },
  { icon: Leaf, title: "Sustainability", text: "Reduce food waste and help the environment.", color: "green" },
];

const steps = [
  { icon: Users, title: "Sign Up", text: "Create your account in minutes." },
  { icon: Store, title: "Add Products", text: "Set up your inventory and batches." },
  { icon: BarChart3, title: "Get AI Insights", text: "Receive predictions and recommendations." },
  { icon: Leaf, title: "Reduce Waste", text: "Make smarter decisions and see real impact." },
];

export default function LandingPage({ onNavigate }: LandingPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  function navigate(path: "/signin" | "/signup") {
    setMenuOpen(false);
    onNavigate(path);
  }

  return (
    <main className="landing-page">
      <header className="landing-header">
        <a className="landing-logo" href="#home" aria-label="WasteWise AI home">
          <span><Leaf size={22} fill="currentColor" /></span>
          <b>WasteWise <i>AI</i></b>
        </a>
        <button className="landing-menu-button" type="button" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={21} /> : <Menu size={21} />}</button>
        <nav className={`landing-nav ${menuOpen ? "open" : ""}`} aria-label="Landing page navigation">
          <a className="selected" href="#home" onClick={() => setMenuOpen(false)}>Home</a>
          <a href="#about" onClick={() => setMenuOpen(false)}>About</a>
          <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
          <a href="#impact" onClick={() => setMenuOpen(false)}>Impact</a>
          <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
          <a href="#contact" onClick={() => setMenuOpen(false)}>Contact</a>
        </nav>
        <div className="landing-auth-buttons">
          <button type="button" className="landing-signin" onClick={() => navigate("/signin")}>Sign In</button>
          <button type="button" className="landing-signup" onClick={() => navigate("/signup")}>Sign Up <ArrowRight size={14} /></button>
        </div>
      </header>

      <section className="landing-hero" id="home">
        <div className="landing-hero-copy">
          <span className="landing-kicker"><Sparkles size={14} /> SMARTER STORES, LESS WASTE</span>
          <h1>Smart Inventory<br />Less Waste<br /><span>A Greener Tomorrow</span></h1>
          <p>AI-powered inventory management for smarter stores, reduced food waste, and a healthier planet.</p>
          <div className="landing-hero-actions">
            <button type="button" className="landing-primary-button" onClick={() => navigate("/signup")}>Get Started <ArrowRight size={16} /></button>
            <a className="landing-secondary-button" href="#about">Learn More <ArrowDown size={15} /></a>
          </div>
          <div className="landing-hero-stats">
            <div><b>50%</b><span>Less Food Waste</span></div>
            <div><b>30%</b><span>Higher Efficiency</span></div>
            <div><b>100%</b><span>Greener Future</span></div>
          </div>
        </div>
        <div className="landing-hero-art" aria-label="Sustainable supermarket illustration">
          <div className="landing-hero-glow" />
          <div className="landing-art-leaves leaf-a">🌿</div><div className="landing-art-leaves leaf-b">🍃</div>
          <StoreIllustration />
          <div className="landing-insight-card"><b><Sparkles size={14} /> AI Insights</b><span><Check size={13} /> Predict Demand</span><span><Check size={13} /> Reduce Waste</span><span><Check size={13} /> Smart Discounts</span></div>
          <div className="landing-impact-card"><b>Real Impact</b><div><i /><i /><i /><i /></div><span>Less Waste<br />More Savings</span></div>
        </div>
      </section>

      <section className="landing-about" id="about">
        <div className="landing-section-heading"><span>THE WASTEWISE DIFFERENCE</span><h2>Why WasteWise AI?</h2><p>Transforming food retail with AI-driven insights and real impact.</p></div>
        <div className="landing-feature-grid" id="features">
          {features.map(({ icon: Icon, title, text, color }) => <article className="landing-feature-card" key={title}><span className={`landing-feature-icon ${color}`}><Icon size={20} /></span><h3>{title}</h3><p>{text}</p></article>)}
        </div>
      </section>

      <section className="landing-impact" id="impact">
        <div className="landing-impact-copy"><span>OUR SHARED FUTURE</span><h2>Built for a Better Tomorrow</h2><p>Helping businesses, communities, and the planet thrive.</p></div>
        <div className="landing-impact-metrics">
          <div><span><Leaf size={19} /></span><b>10K+</b><small>Products Tracked</small></div>
          <div><span><Store size={19} /></span><b>500+</b><small>Stores Supported</small></div>
          <div><span><BarChart3 size={19} /></span><b>2M+</b><small>Kg Food Waste Saved</small></div>
          <div><span><Users size={19} /></span><b>100K+</b><small>People Impacted</small></div>
        </div>
      </section>

      <section className="landing-how" id="how-it-works">
        <div className="landing-section-heading"><span>SIMPLE BY DESIGN</span><h2>How It Works</h2><p>Get started in just a few simple steps.</p></div>
        <div className="landing-steps">{steps.map(({ icon: Icon, title, text }, index) => <article className="landing-step" key={title}><span className="landing-step-icon"><Icon size={21} /></span><div><small>{index + 1}. {title}</small><p>{text}</p></div>{index < steps.length - 1 && <ArrowRight className="landing-step-arrow" size={18} />}</article>)}</div>
      </section>

      <section className="landing-cta" id="pricing">
        <div><h2>Join the Movement for a Sustainable Future</h2><p>Be part of the change. Manage smarter. Waste less. Grow together.</p></div>
        <button type="button" onClick={() => navigate("/signup")}>Sign Up Now <ArrowRight size={16} /></button>
      </section>

      <footer className="landing-footer" id="contact"><a className="landing-logo" href="#home"><span><Leaf size={19} fill="currentColor" /></span><b>WasteWise <i>AI</i></b></a><span>Smart Inventory · Less Waste · A Greener Tomorrow</span><a href="#home">Back to top ↑</a><Recycle size={19} /></footer>
    </main>
  );
}
