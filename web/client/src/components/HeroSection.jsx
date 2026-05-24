import React from 'react';

function HeroPreview() {
  return (
    <div className="hero-preview" aria-label="Chat preview">
      <div className="preview-header">
        <div>
          <div className="preview-title">Team Sync</div>
          <div className="preview-subtitle">Product Updates</div>
        </div>
        <div className="preview-status">12 online</div>
      </div>
      <div className="preview-body">
        <div className="preview-row incoming">
          <div className="preview-bubble">Kickoff moved to 2:30 PM. Agenda is in the doc.</div>
        </div>
        <div className="preview-row incoming">
          <div className="preview-bubble">Can we ship the new onboarding on Friday?</div>
        </div>
        <div className="preview-row outgoing">
          <div className="preview-bubble">Yes. QA finished. Shipping after the demo.</div>
        </div>
      </div>
      <div className="preview-input">
        <span>Message...</span>
        <div className="preview-send">Send</div>
      </div>
    </div>
  );
}

export default function HeroSection({ authCardSlot }) {
  return (
    <section className="hero" id="hero">
      <div className="hero-content">
        <div className="hero-left">
          <div className="hero-badge">Fast, private, always in sync</div>
          <h1 className="hero-title">
            Messaging that feels instant
          </h1>
          <p className="hero-subtitle">
            KafkaChat keeps teams connected with reliable delivery, read receipts, and secure sessions across every device.
          </p>
          <div className="hero-highlights" id="features">
            <div className="highlight-card">
              <div className="highlight-title">Read receipts</div>
              <p>Know when messages land without chasing responses.</p>
            </div>
            <div className="highlight-card">
              <div className="highlight-title">Typing status</div>
              <p>Stay in sync with live typing and presence updates.</p>
            </div>
            <div className="highlight-card">
              <div className="highlight-title">Secure sessions</div>
              <p>Protected transport with optional end-to-end encryption.</p>
            </div>
          </div>

          <HeroPreview />
        </div>

        <div className="hero-right">
          {authCardSlot}
        </div>
      </div>
    </section>
  );
}
