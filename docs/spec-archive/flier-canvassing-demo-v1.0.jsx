import React, { useState, useMemo, useCallback } from "react";
import { MapPin, Camera, Check, X, Clock, Trophy, Crosshair, ChevronLeft, Layers, Navigation } from "lucide-react";

// ---------------------------------------------------------------------------
// Flier Canvassing Platform — interactive prototype
// Demonstrates: landing + universal map → campaign → claim → submit → review → red turns green
// Map is a stylized abstract canvas (no Mapbox token needed for a prototype).
// ---------------------------------------------------------------------------

const FOREST = "#1c5c39";
const RED = "#d2412e";
const AMBER = "#e0a32e";
const GREEN = "#2f8f5b";
const PAPER = "#f6f4ed";
const INK = "#0d1b14";

// Two seeded campaigns so the "universal" map aggregates across tenants.
const SEED = {
  mycofest: {
    id: "mycofest",
    name: "Mycofest 2026",
    blurb: "Spread the spores. Flier the festival corridor.",
    accent: FOREST,
    budgetCents: 100000,
    prize: "2 Mycofest tickets",
    targets: [
      { id: "m1", label: "Co-op bulletin board", x: 22, y: 30, state: "green", by: "spore_dustin" },
      { id: "m2", label: "Trailhead kiosk", x: 40, y: 20, state: "green", by: "fern" },
      { id: "m3", label: "Brewery window", x: 58, y: 34, state: "red" },
      { id: "m4", label: "Feed store corkboard", x: 35, y: 52, state: "red" },
      { id: "m5", label: "Library entrance", x: 66, y: 58, state: "amber", by: "you" },
      { id: "m6", label: "Farmers market post", x: 50, y: 68, state: "red" },
      { id: "m7", label: "Gas station board", x: 76, y: 44, state: "red" },
      { id: "m8", label: "Community center", x: 28, y: 72, state: "green", by: "mush_amy" },
    ],
  },
  records: {
    id: "records",
    name: "Vinyl Fair PDX",
    blurb: "Record fair promo run, downtown core.",
    accent: "#5b3d8a",
    budgetCents: 60000,
    prize: "VIP crate-dig pass",
    targets: [
      { id: "r1", label: "Cafe community wall", x: 30, y: 40, state: "red" },
      { id: "r2", label: "Record shop A", x: 55, y: 28, state: "green", by: "groove" },
      { id: "r3", label: "Venue side door", x: 70, y: 50, state: "red" },
      { id: "r4", label: "Zine library", x: 44, y: 62, state: "amber", by: "wax" },
    ],
  },
};

const TIERS = [
  { min: 1, max: 10, cents: 125 },
  { min: 11, max: 25, cents: 175 },
  { min: 26, max: null, cents: 225 },
];
const payoutForCount = (n) => {
  const band = TIERS.find((t) => n >= t.min && (t.max === null || n <= t.max));
  return band ? band.cents : 0;
};
const fmt = (c) => "$" + (c / 100).toFixed(2);

function pinColor(state) {
  return state === "green" ? GREEN : state === "amber" ? AMBER : RED;
}

// A single map pin, teardrop shape.
function Pin({ t, onClick, dim }) {
  const c = pinColor(t.state);
  return (
    <button
      onClick={onClick}
      style={{
        position: "absolute",
        left: `${t.x}%`,
        top: `${t.y}%`,
        transform: "translate(-50%,-100%)",
        background: "none",
        border: "none",
        cursor: "pointer",
        opacity: dim ? 0.45 : 1,
        transition: "opacity .25s, filter .25s",
        filter: t.state === "amber" ? "drop-shadow(0 0 6px rgba(224,163,46,.7))" : "none",
      }}
      title={t.label}
      aria-label={`${t.label} — ${t.state}`}
    >
      <div
        style={{
          width: 22,
          height: 22,
          background: c,
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          border: "2px solid rgba(0,0,0,.35)",
          boxShadow: "0 3px 6px rgba(0,0,0,.3)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <div style={{ width: 7, height: 7, background: "rgba(255,255,255,.85)", borderRadius: "50%", transform: "rotate(45deg)" }} />
      </div>
    </button>
  );
}

// Stylized abstract map surface (roads + parcels), no external tiles.
function MapSurface({ children, label }) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "4 / 3",
        borderRadius: 12,
        overflow: "hidden",
        background:
          "radial-gradient(120% 120% at 70% 20%, #e8efe6 0%, #dfe7da 40%, #d4ddcd 100%)",
        border: `1.5px solid ${INK}`,
      }}
    >
      {/* parcels */}
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }} preserveAspectRatio="none">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="#c3cdbb" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" opacity="0.6" />
        {/* a couple of "roads" */}
        <path d="M-20 120 Q 200 80 460 200" fill="none" stroke="#b7c1ae" strokeWidth="14" strokeLinecap="round" opacity="0.7" />
        <path d="M120 -20 Q 180 180 90 420" fill="none" stroke="#b7c1ae" strokeWidth="11" strokeLinecap="round" opacity="0.7" />
        {/* a green space */}
        <ellipse cx="78%" cy="74%" rx="60" ry="44" fill="#bcd2b3" opacity="0.6" />
      </svg>
      {label && (
        <div style={{ position: "absolute", left: 12, bottom: 10, fontFamily: "monospace", fontSize: 11, letterSpacing: ".08em", color: "#5d6b60", background: "rgba(246,244,237,.8)", padding: "3px 8px", borderRadius: 4 }}>
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

const btn = (bg, fg = "#fff") => ({
  background: bg, color: fg, border: "none", borderRadius: 6,
  padding: "11px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer",
  fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 8,
});

export default function App() {
  const [campaigns, setCampaigns] = useState(SEED);
  const [view, setView] = useState("landing"); // landing | campaign | claim | submitting | pending
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [activeTarget, setActiveTarget] = useState(null);
  const [approvedCount, setApprovedCount] = useState(2); // pretend "you" already have 2
  const [toast, setToast] = useState(null);

  const universalPins = useMemo(() => {
    return Object.values(campaigns).flatMap((c) =>
      c.targets.map((t) => ({ ...t, campaignId: c.id, accent: c.accent }))
    );
  }, [campaigns]);

  const coverage = useCallback((c) => {
    const total = c.targets.length;
    const green = c.targets.filter((t) => t.state === "green").length;
    return Math.round((green / total) * 100);
  }, []);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const openCampaign = (c) => {
    setActiveCampaign(c.id);
    setView("campaign");
  };

  const tapTarget = (t) => {
    if (t.state === "red") {
      setActiveTarget(t.id);
      setView("claim");
    } else if (t.state === "green") {
      setActiveTarget(t.id);
      setView("pinDetail");
    } else {
      flash("That pin is claimed and pending review.");
    }
  };

  const claim = () => {
    setCampaigns((prev) => {
      const c = { ...prev[activeCampaign] };
      c.targets = c.targets.map((t) => (t.id === activeTarget ? { ...t, state: "amber", by: "you" } : t));
      return { ...prev, [activeCampaign]: c };
    });
    setView("submitting");
  };

  const submit = () => {
    setView("pending");
    flash("Submitted — under review");
  };

  // Reviewer approves (simulating the host side) → pin turns green, payout accrues.
  const approve = () => {
    setCampaigns((prev) => {
      const c = { ...prev[activeCampaign] };
      c.targets = c.targets.map((t) => (t.id === activeTarget ? { ...t, state: "green", by: "you" } : t));
      return { ...prev, [activeCampaign]: c };
    });
    const newCount = approvedCount + 1;
    setApprovedCount(newCount);
    flash(`Approved! +${fmt(payoutForCount(newCount))} · pin is green`);
    setView("campaign");
    setActiveTarget(null);
  };

  const reject = () => {
    setCampaigns((prev) => {
      const c = { ...prev[activeCampaign] };
      c.targets = c.targets.map((t) => (t.id === activeTarget ? { ...t, state: "red", by: undefined } : t));
      return { ...prev, [activeCampaign]: c };
    });
    flash("Rejected — pin back to red, reopened");
    setView("campaign");
    setActiveTarget(null);
  };

  const cur = activeCampaign ? campaigns[activeCampaign] : null;
  const tgt = cur && activeTarget ? cur.targets.find((t) => t.id === activeTarget) : null;
  const nextPayout = fmt(payoutForCount(approvedCount + 1));
  const curTier = TIERS.findIndex((t) => approvedCount >= t.min && (t.max === null || approvedCount <= t.max)) + 1;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, color: INK, fontFamily: "'Inter',system-ui,sans-serif" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 16px 60px" }}>

        {/* Top bar */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 4px", borderBottom: `2px solid ${INK}`, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 18, height: 18, background: RED, borderRadius: "50% 50% 50% 0", transform: "rotate(-45deg)", border: "2px solid rgba(0,0,0,.3)" }} />
            <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 18, letterSpacing: "-.01em" }}>PINDROP</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#5d6b60", marginLeft: 4 }}>canvassing · prototype</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13 }}>
            <span style={{ fontFamily: "monospace", color: "#5d6b60" }}>player: you</span>
            <span style={{ background: INK, color: PAPER, padding: "4px 10px", borderRadius: 20, fontFamily: "monospace", fontSize: 12 }}>
              {approvedCount} ✓ · tier {curTier}
            </span>
          </div>
        </header>

        {/* LANDING + UNIVERSAL MAP */}
        {view === "landing" && (
          <>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontFamily: "monospace", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: "#5d6b60", display: "flex", alignItems: "center", gap: 8 }}>
                <Layers size={13} /> Universal map · all live campaigns
              </div>
              <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 34, lineHeight: 1.05, margin: "8px 0 6px", letterSpacing: "-.02em" }}>
                Every flier, <span style={{ color: RED }}>pinned</span> &amp; <span style={{ color: GREEN }}>claimed</span>.
              </h1>
              <p style={{ color: "#3a473e", maxWidth: "52ch", fontSize: 15 }}>
                Pick a campaign, claim a red pin, post the flier, snap a photo. Approved placements turn the pin green and pay you.
              </p>
            </div>

            <MapSurface label="aggregating 2 live campaigns">
              {universalPins.map((t) => (
                <Pin key={t.campaignId + t.id} t={t} onClick={() => openCampaign(campaigns[t.campaignId])} />
              ))}
            </MapSurface>

            <div style={{ display: "flex", gap: 18, margin: "14px 2px 22px", fontFamily: "monospace", fontSize: 12.5, color: "#3a473e", flexWrap: "wrap" }}>
              <Legend c={RED} label="open" />
              <Legend c={AMBER} label="claimed / pending" />
              <Legend c={GREEN} label="approved" />
            </div>

            <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 17, marginBottom: 10 }}>Live campaigns</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {Object.values(campaigns).map((c) => (
                <button key={c.id} onClick={() => openCampaign(c)}
                  style={{ textAlign: "left", background: "#fff", border: `1px solid #cdc7b6`, borderRadius: 10, padding: 16, cursor: "pointer", fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: c.accent }} />
                      <strong style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 16 }}>{c.name}</strong>
                    </div>
                    <div style={{ fontSize: 13.5, color: "#5d6b60", marginTop: 3 }}>{c.blurb}</div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 86 }}>
                    <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 22, color: c.accent }}>{coverage(c)}%</div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5d6b60" }}>covered</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* CAMPAIGN VIEW */}
        {view === "campaign" && cur && (
          <>
            <BackBar onBack={() => { setView("landing"); setActiveTarget(null); }} label="Universal map" />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: cur.accent }} />
                  <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 26, margin: 0 }}>{cur.name}</h1>
                </div>
                <p style={{ color: "#5d6b60", fontSize: 14, margin: "4px 0 0" }}>{cur.blurb}</p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", background: "#fff", border: "1px solid #cdc7b6", borderRadius: 8, padding: "8px 12px" }}>
                <Trophy size={16} color={AMBER} />
                <div style={{ fontSize: 13 }}><strong>{cur.prize}</strong><div style={{ fontSize: 11, color: "#5d6b60" }}>top canvasser</div></div>
              </div>
            </div>

            <MapSurface label={`${cur.name} · ${coverage(cur)}% covered`}>
              {cur.targets.map((t) => (
                <Pin key={t.id} t={t} onClick={() => tapTarget(t)} />
              ))}
            </MapSurface>

            <div style={{ display: "flex", gap: 18, margin: "12px 2px 18px", fontFamily: "monospace", fontSize: 12.5, color: "#3a473e", flexWrap: "wrap" }}>
              <Legend c={RED} label="tap to claim" />
              <Legend c={AMBER} label="pending" />
              <Legend c={GREEN} label="done" />
            </div>

            <div style={{ background: "#fff", border: "1px solid #cdc7b6", borderRadius: 10, padding: 16 }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "#5d6b60", marginBottom: 10 }}>Your progress</div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Stat label="approved" value={approvedCount} />
                <Stat label="current tier" value={`T${curTier}`} />
                <Stat label="next flier pays" value={nextPayout} accent={cur.accent} />
                <Stat label="open pins" value={cur.targets.filter(t => t.state === "red").length} />
              </div>
            </div>
          </>
        )}

        {/* CLAIM */}
        {view === "claim" && cur && tgt && (
          <Sheet onBack={() => setView("campaign")}>
            <SheetHeader icon={<Crosshair size={20} />} title="Claim this target" sub={tgt.label} />
            <MiniMap target={tgt} />
            <div style={{ background: "#f3e9d5", border: `1px solid ${AMBER}`, borderRadius: 8, padding: "10px 13px", fontSize: 13.5, color: "#7a5712", margin: "14px 0", display: "flex", gap: 8 }}>
              <Clock size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              Claiming reserves this pin for <strong>&nbsp;3 hours</strong>&nbsp;so no one else takes it. Post the flier here, then submit a photo.
            </div>
            <button style={{ ...btn(cur.accent), width: "100%", justifyContent: "center" }} onClick={claim}>
              <Crosshair size={17} /> Claim &amp; start
            </button>
          </Sheet>
        )}

        {/* SUBMITTING (capture) */}
        {view === "submitting" && cur && tgt && (
          <Sheet onBack={() => setView("campaign")}>
            <SheetHeader icon={<Camera size={20} />} title="Post the flier, then capture" sub={tgt.label} />
            <div style={{ position: "relative", aspectRatio: "3/4", maxHeight: 320, margin: "0 auto", background: "#11201a", borderRadius: 12, display: "grid", placeItems: "center", overflow: "hidden", border: `1.5px solid ${INK}` }}>
              <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(45deg,#16271f,#16271f 12px,#13231c 12px,#13231c 24px)", opacity: .5 }} />
              <div style={{ textAlign: "center", color: "#7fd0a0", zIndex: 1 }}>
                <Camera size={40} />
                <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 8, letterSpacing: ".1em" }}>REAR CAMERA</div>
                <div style={{ fontSize: 11, color: "#9fb8a8", marginTop: 4 }}>GPS + EXIF + timestamp captured on shot</div>
              </div>
              {/* framing brackets */}
              {["tl","tr","bl","br"].map((p) => (
                <div key={p} style={{ position: "absolute", width: 26, height: 26, borderColor: "#7fd0a0", borderStyle: "solid",
                  borderWidth: p==="tl"?"2px 0 0 2px":p==="tr"?"2px 2px 0 0":p==="bl"?"0 0 2px 2px":"0 2px 2px 0",
                  top: p[0]==="t"?14:undefined, bottom: p[0]==="b"?14:undefined, left: p[1]==="l"?14:undefined, right: p[1]==="r"?14:undefined }} />
              ))}
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 12, color: "#5d6b60", textAlign: "center", margin: "12px 0" }}>
              <Navigation size={12} style={{ verticalAlign: "-2px" }} /> within 40m of target · GPS locked
            </div>
            <button style={{ ...btn(cur.accent), width: "100%", justifyContent: "center" }} onClick={submit}>
              <Camera size={17} /> Capture &amp; submit
            </button>
          </Sheet>
        )}

        {/* PENDING → reviewer simulation */}
        {view === "pending" && cur && tgt && (
          <Sheet onBack={() => setView("campaign")}>
            <SheetHeader icon={<Clock size={20} />} title="Under review" sub={tgt.label} />
            <div style={{ textAlign: "center", padding: "10px 0 18px" }}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f3e9d5", display: "grid", placeItems: "center", margin: "0 auto 12px", border: `2px solid ${AMBER}` }}>
                <Clock size={28} color={AMBER} />
              </div>
              <p style={{ color: "#3a473e", fontSize: 14.5, maxWidth: "40ch", margin: "0 auto" }}>
                Your submission ran through the fraud pipeline and is queued for the host. The pin stays amber until a decision.
              </p>
            </div>

            <div style={{ background: "#fbfaf6", border: "1px dashed #b6b09c", borderRadius: 10, padding: 14 }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, letterSpacing: ".1em", textTransform: "uppercase", color: "#5d6b60", marginBottom: 8 }}>
                Host review panel <span style={{ color: "#b08", textTransform: "none", letterSpacing: 0 }}>(you're simulating the host)</span>
              </div>
              <CheckRow ok label="Target proximity" detail="18m — within 40m" />
              <CheckRow ok label="GPS ↔ EXIF agreement" detail="22m apart" />
              <CheckRow ok label="Duplicate (different-target)" detail="no match" />
              <CheckRow ok label="Timestamp sanity" detail="fresh, consistent" />
              <CheckRow ok label="Travel-speed" detail="plausible" />
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button style={{ ...btn(GREEN), flex: 1, justifyContent: "center" }} onClick={approve}><Check size={17} /> Approve</button>
                <button style={{ ...btn("#fff", RED), flex: 1, justifyContent: "center", border: `1.5px solid ${RED}` }} onClick={reject}><X size={17} /> Reject</button>
              </div>
            </div>
          </Sheet>
        )}

        {/* GREEN PIN DETAIL */}
        {view === "pinDetail" && cur && tgt && (
          <Sheet onBack={() => setView("campaign")}>
            <SheetHeader icon={<Check size={20} />} title="Filled target" sub={tgt.label} />
            <div style={{ aspectRatio: "3/4", maxHeight: 280, margin: "0 auto 14px", background: "linear-gradient(135deg,#2f8f5b,#1c5c39)", borderRadius: 12, display: "grid", placeItems: "center", border: `1.5px solid ${INK}` }}>
              <div style={{ textAlign: "center", color: "#eaf6ee" }}>
                <Check size={36} />
                <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 6 }}>FLIER PHOTO</div>
              </div>
            </div>
            <DetailRow label="Status" value="Approved · green" />
            <DetailRow label="Placed by" value={tgt.by === "you" ? "you" : (cur.privacyPublic === false ? "hidden (admin-only)" : tgt.by || "—")} />
            <DetailRow label="GPS" value="45.2031, −123.9620" mono />
            <DetailRow label="Campaign" value={cur.name} />
            <p style={{ fontFamily: "monospace", fontSize: 11, color: "#5d6b60", marginTop: 10 }}>
              Username visibility follows the per-campaign privacy setting (default admin-only).
            </p>
          </Sheet>
        )}

      </div>

      {/* toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: INK, color: PAPER, padding: "12px 18px", borderRadius: 10, fontSize: 14, fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,.3)", zIndex: 50, maxWidth: "90%", textAlign: "center" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// --- small components ---
function Legend({ c, label }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 12, height: 12, background: c, borderRadius: "50% 50% 50% 0", transform: "rotate(-45deg)", border: "1.5px solid rgba(0,0,0,.3)" }} />
      {label}
    </span>
  );
}
function Stat({ label, value, accent = INK }) {
  return (
    <div>
      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 22, color: accent }}>{value}</div>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5d6b60", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
    </div>
  );
}
function BackBar({ onBack, label }) {
  return (
    <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "monospace", fontSize: 13, color: "#5d6b60", display: "flex", alignItems: "center", gap: 4, padding: "0 0 14px" }}>
      <ChevronLeft size={16} /> {label}
    </button>
  );
}
function Sheet({ children, onBack }) {
  return (
    <div>
      <BackBar onBack={onBack} label="Back to map" />
      <div style={{ background: "#fff", border: `1px solid #cdc7b6`, borderRadius: 14, padding: 20 }}>{children}</div>
    </div>
  );
}
function SheetHeader({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
      <div style={{ width: 42, height: 42, borderRadius: 10, background: PAPER, display: "grid", placeItems: "center", color: INK, flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, fontSize: 18 }}>{title}</div>
        <div style={{ fontSize: 13, color: "#5d6b60" }}>{sub}</div>
      </div>
    </div>
  );
}
function MiniMap({ target }) {
  return (
    <div style={{ position: "relative", height: 150, borderRadius: 10, overflow: "hidden", border: "1px solid #cdc7b6", background: "radial-gradient(120% 120% at 60% 30%, #e8efe6, #d4ddcd)" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <circle cx="50%" cy="52%" r="46" fill="none" stroke={AMBER} strokeWidth="1.5" strokeDasharray="4 4" opacity=".7" />
        <text x="50%" y="14%" fontFamily="monospace" fontSize="10" fill="#5d6b60" textAnchor="middle">40m radius</text>
      </svg>
      <div style={{ position: "absolute", left: "50%", top: "52%", transform: "translate(-50%,-100%)" }}>
        <div style={{ width: 22, height: 22, background: RED, borderRadius: "50% 50% 50% 0", transform: "rotate(-45deg)", border: "2px solid rgba(0,0,0,.35)" }} />
      </div>
    </div>
  );
}
function CheckRow({ ok, label, detail }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13.5 }}>
      <span style={{ width: 18, height: 18, borderRadius: "50%", background: ok ? "#dbe9df" : "#f1d6d0", display: "grid", placeItems: "center", flexShrink: 0 }}>
        {ok ? <Check size={12} color={GREEN} /> : <X size={12} color={RED} />}
      </span>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 12, color: "#5d6b60" }}>{detail}</span>
    </div>
  );
}
function DetailRow({ label, value, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid #ece8dc", fontSize: 14 }}>
      <span style={{ color: "#5d6b60" }}>{label}</span>
      <span style={{ fontWeight: 600, fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
    </div>
  );
}
