import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, Legend
} from "recharts";

// ── Palette ──────────────────────────────────────────────────────────────────
const SENSOR_COLORS = [
  "#38bdf8", "#34d399", "#fb923c", "#a78bfa", "#f472b6",
  "#facc15", "#22d3ee", "#86efac", "#fda4af", "#c4b5fd",
];

const RANGE_OPTIONS = [
  { label: "6 h",  hours: 6 },
  { label: "24 h", hours: 24 },
  { label: "3 d",  hours: 72 },
  { label: "7 d",  hours: 168 },
];

// ── HA API helpers ────────────────────────────────────────────────────────────
async function haFetch(url, token, path) {
  const base = url.replace(/\/$/, "");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`HA ${r.status}: ${r.statusText}`);
  return r.json();
}

async function fetchAllStates(url, token) {
  return haFetch(url, token, "/api/states");
}

async function fetchHistory(url, token, entityIds, hours) {
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const ids = entityIds.join(",");
  return haFetch(url, token, `/api/history/period/${start}?filter_entity_id=${ids}&minimal_response=true`);
}

// ── Merge history arrays into unified time-series ────────────────────────────
function mergeHistory(histories, entityIds, unit, sensorHaUnits) {
  // Build a sorted list of all timestamps
  const allTimes = new Set();
  const maps = {};

  histories.forEach((series, i) => {
    const id = entityIds[i];
    maps[id] = {};
    series.forEach(({ last_changed, state }) => {
      const v = parseFloat(state);
      if (isNaN(v)) return;
      const haUnit = sensorHaUnits?.[id] ?? "°C";
      // Normalise to display unit
      let val = v;
      if (haUnit === "°C" && unit === "°F") val = v * 9/5 + 32;
      if (haUnit === "°F" && unit === "°C") val = (v - 32) * 5/9;
      const t = new Date(last_changed).getTime();
      allTimes.add(t);
      maps[id][t] = val;
    });
  });

  const sorted = [...allTimes].sort((a, b) => a - b);

  // Forward-fill each sensor
  const lastVal = {};
  return sorted.map(t => {
    const point = { t };
    entityIds.forEach(id => {
      if (maps[id][t] !== undefined) lastVal[id] = maps[id][t];
      if (lastVal[id] !== undefined) point[id] = +lastVal[id].toFixed(1);
    });
    return point;
  });
}

// Build heat-on reference areas from climate entity history
function buildHeatBands(climateSeries) {
  const bands = [];
  let start = null;
  climateSeries.forEach(({ last_changed, state }) => {
    const t = new Date(last_changed).getTime();
    const heating = state === "heat" || state === "heat_cool" || state === "auto";
    if (heating && start === null) start = t;
    if (!heating && start !== null) { bands.push({ x1: start, x2: t }); start = null; }
  });
  if (start !== null) bands.push({ x1: start, x2: Date.now() });
  return bands;
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, unit, sensorMeta }) {
  if (!active || !payload?.length) return null;
  const d = new Date(label);
  return (
    <div style={{
      background: "rgba(15,23,42,0.95)", border: "1px solid #1e3a5f",
      borderRadius: 10, padding: "10px 14px", fontSize: 12,
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)"
    }}>
      <div style={{ color: "#94a3b8", marginBottom: 6, fontFamily: "monospace" }}>
        {d.toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
        {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.color, display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
          <span style={{ color: "#cbd5e1", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {sensorMeta[p.dataKey]?.label ?? p.dataKey}
          </span>
          <span style={{ marginLeft: "auto", fontWeight: 700, color: "#f1f5f9" }}>
            {p.value}{unit}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Sensor card ───────────────────────────────────────────────────────────────
function SensorCard({ id, meta, current, unit, color, selected, onToggle }) {
  return (
    <button onClick={() => onToggle(id)} style={{
      background: selected ? `${color}18` : "rgba(15,23,42,0.6)",
      border: `1.5px solid ${selected ? color : "#1e293b"}`,
      borderRadius: 12, padding: "12px 16px", cursor: "pointer",
      display: "flex", flexDirection: "column", gap: 4, textAlign: "left",
      transition: "all 0.2s", minWidth: 140, flex: "1 1 140px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0,
          boxShadow: selected ? `0 0 8px ${color}` : "none" }} />
        <span style={{ fontSize: 11, color: selected ? "#94a3b8" : "#475569", fontFamily: "monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: selected ? "#f1f5f9" : "#475569",
        fontFamily: "'DM Mono', monospace", letterSpacing: -1, lineHeight: 1 }}>
        {current !== undefined ? `${current.toFixed(1)}${unit}` : "—"}
      </div>
      <div style={{ fontSize: 10, color: "#334155", textTransform: "uppercase", letterSpacing: 1 }}>
        {meta.room ?? "sensor"}
      </div>
    </button>
  );
}

// ── Setup screen ──────────────────────────────────────────────────────────────
function SetupScreen({ onConnect }) {
  const [haUrl, setHaUrl] = useState("http://homeassistant.local:8123"); // pre-filled
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleConnect() {
    setLoading(true); setError(null);
    try {
      const states = await fetchAllStates(haUrl, token);
      onConnect(haUrl, token, states);
    } catch (e) {
      setError(e.message || "Could not connect. Check URL and token.");
    } finally { setLoading(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#020810", display: "flex",
      alignItems: "center", justifyContent: "center", fontFamily: "'DM Mono', monospace" }}>
      <div style={{ width: 420, padding: 40, background: "rgba(14,22,38,0.9)",
        border: "1px solid #1e3a5f", borderRadius: 20,
        boxShadow: "0 0 80px rgba(14,116,219,0.12)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🌡️</div>
          <h1 style={{ color: "#f1f5f9", fontSize: 22, margin: 0, fontWeight: 700, letterSpacing: -0.5 }}>
            House Temps
          </h1>
          <p style={{ color: "#475569", fontSize: 13, margin: "8px 0 0" }}>
            Connect to your Home Assistant instance
          </p>
        </div>

        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1,
            display: "block", marginBottom: 6 }}>Home Assistant URL</span>
          <input value={haUrl} onChange={e => setHaUrl(e.target.value)}
            style={{ width: "100%", background: "#0c1929", border: "1px solid #1e3a5f",
              borderRadius: 8, padding: "10px 12px", color: "#e2e8f0", fontSize: 13,
              outline: "none", boxSizing: "border-box" }} />
        </label>

        <label style={{ display: "block", marginBottom: 24 }}>
          <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1,
            display: "block", marginBottom: 6 }}>Long-Lived Access Token</span>
          <textarea value={token} onChange={e => setToken(e.target.value)}
            rows={3} placeholder="eyJ0eXAiOiJKV1Q..."
            style={{ width: "100%", background: "#0c1929", border: "1px solid #1e3a5f",
              borderRadius: 8, padding: "10px 12px", color: "#e2e8f0", fontSize: 12,
              outline: "none", resize: "none", boxSizing: "border-box", fontFamily: "monospace" }} />
          <span style={{ fontSize: 11, color: "#334155", display: "block", marginTop: 4 }}>
            Profile → Security → Long-Lived Access Tokens in HA
          </span>
        </label>

        {error && (
          <div style={{ background: "#1c0a0a", border: "1px solid #7f1d1d", borderRadius: 8,
            padding: "10px 12px", color: "#fca5a5", fontSize: 12, marginBottom: 16 }}>
            ⚠ {error}
          </div>
        )}

        <button onClick={handleConnect} disabled={loading || !token}
          style={{ width: "100%", padding: "12px", background: loading ? "#1e3a5f" : "#0ea5e9",
            border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700,
            cursor: loading ? "default" : "pointer", transition: "background 0.2s",
            fontFamily: "'DM Mono', monospace" }}>
          {loading ? "Connecting…" : "Connect →"}
        </button>
      </div>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────
function Dashboard({ haUrl, token, initialStates, onDisconnect }) {
  const [unit, setUnit] = useState("°C");
  const [rangeHours, setRangeHours] = useState(168);
  const [allSensors, setAllSensors] = useState([]);   // { id, label, room, type }
  const [allClimates, setAllClimates] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedClimate, setSelectedClimate] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [heatBands, setHeatBands] = useState([]);
  const [currentVals, setCurrentVals] = useState({});
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [setupDone, setSetupDone] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  // Parse states on mount
  useEffect(() => {
    const temps = initialStates.filter(s =>
      s.entity_id.startsWith("sensor.") &&
      (s.attributes?.unit_of_measurement === "°C" ||
       s.attributes?.unit_of_measurement === "°F") &&
      !isNaN(parseFloat(s.state))
    ).map(s => ({
      id: s.entity_id,
      label: s.attributes.friendly_name || s.entity_id,
      room: guessRoom(s.attributes.friendly_name || s.entity_id),
      ha_unit: s.attributes.unit_of_measurement,
    }));

    const climates = initialStates.filter(s =>
      s.entity_id.startsWith("climate.")
    ).map(s => ({
      id: s.entity_id,
      label: s.attributes.friendly_name || s.entity_id,
    }));

    const cur = {};
    temps.forEach(s => {
      const raw = parseFloat(initialStates.find(x => x.entity_id === s.id)?.state);
      if (!isNaN(raw)) cur[s.id] = { value: raw, ha_unit: s.ha_unit };
    });

    setAllSensors(temps);
    setAllClimates(climates);
    setCurrentVals(cur);
    setSelectedIds(temps.slice(0, Math.min(6, temps.length)).map(s => s.id));
    if (climates.length) setSelectedClimate(climates[0].id);
    setSetupDone(true);
  }, [initialStates]);

  // Fetch history whenever selection / range changes
  const loadHistory = useCallback(async () => {
    if (!selectedIds.length) return;
    setLoading(true);
    try {
      const ids = selectedClimate ? [...selectedIds, selectedClimate] : selectedIds;
      const results = await fetchHistory(haUrl, token, ids, rangeHours);

      // Separate temp and climate histories
      const tempHistories = [];
      let climateHistory = [];
      ids.forEach((id, i) => {
        const series = results[i] || [];
        if (id === selectedClimate) climateHistory = series;
        else tempHistories.push(series);
      });

      const haUnits = Object.fromEntries(allSensors.map(s => [s.id, s.ha_unit]));
      const merged = mergeHistory(tempHistories, selectedIds, unit, haUnits);
      setChartData(merged);
      setHeatBands(buildHeatBands(climateHistory));
      setLastRefresh(new Date());
    } catch (e) {
      console.error(e);
    } finally { setLoading(false); }
  }, [haUrl, token, selectedIds, selectedClimate, rangeHours, unit]);

  useEffect(() => { if (setupDone) loadHistory(); }, [loadHistory, setupDone]);

  // Auto-refresh every 2 min
  useEffect(() => {
    const t = setInterval(loadHistory, 120_000);
    return () => clearInterval(t);
  }, [loadHistory]);

  const toggleSensor = id => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  );

  const sensorMeta = Object.fromEntries(allSensors.map(s => [s.id, s]));
  const colorMap = Object.fromEntries(
    allSensors.map((s, i) => [s.id, SENSOR_COLORS[i % SENSOR_COLORS.length]])
  );

  const xTicks = buildXTicks(chartData, rangeHours);

  const isHeating = heatBands.some(b => b.x2 >= Date.now() - 5 * 60_000 && b.x2 <= Date.now() + 1000);

  return (
    <div style={{ minHeight: "100vh", background: "#020810", color: "#e2e8f0",
      fontFamily: "'DM Mono', monospace", padding: "24px 28px", boxSizing: "border-box" }}>

      {/* Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e3a5f; border-radius: 3px; }
        .sensor-grid { display: flex; flex-wrap: wrap; gap: 10px; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 28 }}>🌡️</span>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#f1f5f9",
              fontFamily: "'DM Sans', sans-serif", letterSpacing: -0.5 }}>House Temps</h1>
            <div style={{ fontSize: 11, color: "#334155", marginTop: 2 }}>
              {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Loading…"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Heat badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
            background: isHeating ? "rgba(251,146,60,0.15)" : "rgba(30,58,95,0.4)",
            border: `1px solid ${isHeating ? "#fb923c" : "#1e3a5f"}`, borderRadius: 20,
            transition: "all 0.4s",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%",
              background: isHeating ? "#fb923c" : "#1e3a5f",
              boxShadow: isHeating ? "0 0 10px #fb923c" : "none",
              animation: isHeating ? "pulse 2s infinite" : "none" }} />
            <span style={{ fontSize: 11, color: isHeating ? "#fb923c" : "#334155",
              fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>
              {isHeating ? "Heat On" : "Heat Off"}
            </span>
          </div>

          {/* Unit toggle */}
          <div style={{ display: "flex", background: "#0c1929", borderRadius: 8, overflow: "hidden",
            border: "1px solid #1e3a5f" }}>
            {["°F", "°C"].map(u => (
              <button key={u} onClick={() => setUnit(u)} style={{
                padding: "6px 14px", background: unit === u ? "#0ea5e9" : "transparent",
                border: "none", color: unit === u ? "#fff" : "#475569", cursor: "pointer",
                fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace",
              }}>{u}</button>
            ))}
          </div>

          {/* Range selector */}
          <div style={{ display: "flex", background: "#0c1929", borderRadius: 8, overflow: "hidden",
            border: "1px solid #1e3a5f" }}>
            {RANGE_OPTIONS.map(opt => (
              <button key={opt.hours} onClick={() => setRangeHours(opt.hours)} style={{
                padding: "6px 12px", background: rangeHours === opt.hours ? "#1e3a5f" : "transparent",
                border: "none", color: rangeHours === opt.hours ? "#7dd3fc" : "#475569",
                cursor: "pointer", fontSize: 12, fontFamily: "'DM Mono', monospace",
              }}>{opt.label}</button>
            ))}
          </div>

          <button onClick={loadHistory} disabled={loading} style={{
            padding: "6px 12px", background: "#0c1929", border: "1px solid #1e3a5f",
            borderRadius: 8, color: "#64748b", cursor: "pointer", fontSize: 12,
          }}>{loading ? "⟳" : "↺"}</button>

          <button onClick={onDisconnect} title="Disconnect & clear saved credentials" style={{
            padding: "6px 12px", background: "#0c1929", border: "1px solid #1e3a5f",
            borderRadius: 8, color: "#475569", cursor: "pointer", fontSize: 12,
          }}>⏏</button>
        </div>
      </div>

      {/* Sensor cards */}
      <div className="sensor-grid" style={{ marginBottom: 24 }}>
        {allSensors.map((s, i) => (
          <SensorCard key={s.id} id={s.id} meta={s}
            current={(() => {
              const entry = currentVals[s.id];
              if (!entry) return undefined;
              if (entry.ha_unit === "°C" && unit === "°F") return entry.value * 9/5 + 32;
              if (entry.ha_unit === "°F" && unit === "°C") return (entry.value - 32) * 5/9;
              return entry.value;
            })()}
            color={colorMap[s.id]}
            selected={selectedIds.includes(s.id)}
            onToggle={toggleSensor} />
        ))}
      </div>

      {/* Chart */}
      <div style={{ background: "rgba(14,22,38,0.7)", border: "1px solid #1e3a5f",
        borderRadius: 16, padding: "20px 8px 12px 4px",
        boxShadow: "0 0 40px rgba(14,116,219,0.06)" }}>
        {chartData.length === 0 && !loading ? (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#334155", fontSize: 13 }}>
            No data — select sensors and a time range above
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={380}>
            <LineChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 4 }}>
              <defs>
                {heatBands.map((_, i) => null)}
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#0f2039" vertical={false} />

              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]}
                scale="time" ticks={xTicks}
                tickFormatter={t => formatXTick(t, rangeHours)}
                tick={{ fill: "#334155", fontSize: 11, fontFamily: "monospace" }}
                axisLine={{ stroke: "#1e3a5f" }} tickLine={false} />

              <YAxis domain={["auto", "auto"]}
                tickFormatter={v => `${v}${unit}`}
                tick={{ fill: "#334155", fontSize: 11, fontFamily: "monospace" }}
                axisLine={false} tickLine={false} width={52} />

              <Tooltip content={<CustomTooltip unit={unit} sensorMeta={sensorMeta} />} />

              {/* Heat bands */}
              {heatBands.map((b, i) => (
                <ReferenceArea key={i} x1={b.x1} x2={b.x2}
                  fill="#fb923c" fillOpacity={0.07}
                  stroke="#fb923c" strokeOpacity={0.2} strokeWidth={1} />
              ))}

              {selectedIds.map(id => (
                <Line key={id} type="monotone" dataKey={id}
                  stroke={colorMap[id]} strokeWidth={1.8}
                  dot={false} activeDot={{ r: 4, stroke: colorMap[id], strokeWidth: 2 }}
                  connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Legend */}
      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#334155" }}>
          <span style={{ width: 28, height: 4, background: "rgba(251,146,60,0.35)",
            borderRadius: 2, display: "inline-block", border: "1px solid rgba(251,146,60,0.5)" }} />
          Heat running
        </div>
        {selectedIds.map(id => (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 6,
            fontSize: 11, color: "#475569" }}>
            <span style={{ width: 20, height: 2, background: colorMap[id],
              display: "inline-block", borderRadius: 1 }} />
            {sensorMeta[id]?.label ?? id}
          </div>
        ))}
      </div>

      {/* Climate selector */}
      {allClimates.length > 0 && (
        <div style={{ marginTop: 20, fontSize: 11, color: "#334155" }}>
          <span style={{ textTransform: "uppercase", letterSpacing: 1, marginRight: 10 }}>Heat entity:</span>
          {allClimates.map(c => (
            <button key={c.id} onClick={() => setSelectedClimate(c.id)} style={{
              marginRight: 6, padding: "4px 10px", borderRadius: 6, border: "1px solid",
              borderColor: selectedClimate === c.id ? "#0ea5e9" : "#1e3a5f",
              background: selectedClimate === c.id ? "rgba(14,165,233,0.1)" : "transparent",
              color: selectedClimate === c.id ? "#7dd3fc" : "#334155",
              fontSize: 11, cursor: "pointer", fontFamily: "'DM Mono', monospace",
            }}>{c.label}</button>
          ))}
          <button onClick={() => setSelectedClimate(null)} style={{
            marginRight: 6, padding: "4px 10px", borderRadius: 6, border: "1px solid",
            borderColor: selectedClimate === null ? "#f43f5e" : "#1e3a5f",
            background: selectedClimate === null ? "rgba(244,63,94,0.1)" : "transparent",
            color: selectedClimate === null ? "#fda4af" : "#334155",
            fontSize: 11, cursor: "pointer", fontFamily: "'DM Mono', monospace",
          }}>None</button>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function guessRoom(name) {
  const n = name.toLowerCase();
  if (n.includes("bedroom") || n.includes("bed")) return "Bedroom";
  if (n.includes("living") || n.includes("lounge")) return "Living Room";
  if (n.includes("kitchen")) return "Kitchen";
  if (n.includes("office") || n.includes("study")) return "Office";
  if (n.includes("basement") || n.includes("cellar")) return "Basement";
  if (n.includes("garage")) return "Garage";
  if (n.includes("bathroom") || n.includes("bath")) return "Bathroom";
  if (n.includes("outdoor") || n.includes("outside") || n.includes("patio")) return "Outdoor";
  if (n.includes("hall") || n.includes("entry") || n.includes("foyer")) return "Hallway";
  return "";
}

function buildXTicks(data, hours) {
  if (!data.length) return [];
  const min = data[0].t, max = data[data.length - 1].t;
  const step = hours <= 6 ? 3600_000 : hours <= 24 ? 4 * 3600_000 : hours <= 72 ? 12 * 3600_000 : 24 * 3600_000;
  const ticks = [];
  let t = Math.ceil(min / step) * step;
  while (t <= max) { ticks.push(t); t += step; }
  return ticks;
}

function formatXTick(t, hours) {
  const d = new Date(t);
  if (hours <= 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── App root ──────────────────────────────────────────────────────────────────
export default function App() {
  const [conn, setConn] = useState(null);
  const [booting, setBooting] = useState(true);

  // On load, try to auto-connect from saved credentials
  useEffect(() => {
    const saved = localStorage.getItem("ha-dashboard-creds");
    if (saved) {
      try {
        const { url, token } = JSON.parse(saved);
        fetchAllStates(url, token)
          .then(states => setConn({ url, token, states }))
          .catch(() => localStorage.removeItem("ha-dashboard-creds"))
          .finally(() => setBooting(false));
      } catch {
        setBooting(false);
      }
    } else {
      setBooting(false);
    }
  }, []);

  function handleConnect(url, token, states) {
    localStorage.setItem("ha-dashboard-creds", JSON.stringify({ url, token }));
    setConn({ url, token, states });
  }

  function handleDisconnect() {
    localStorage.removeItem("ha-dashboard-creds");
    setConn(null);
  }

  if (booting) return (
    <div style={{ minHeight: "100vh", background: "#020810", display: "flex",
      alignItems: "center", justifyContent: "center", color: "#334155",
      fontFamily: "'DM Mono', monospace", fontSize: 14 }}>
      Connecting to Home Assistant…
    </div>
  );

  if (!conn) return <SetupScreen onConnect={handleConnect} />;

  return (
    <Dashboard
      haUrl={conn.url}
      token={conn.token}
      initialStates={conn.states}
      onDisconnect={handleDisconnect}
    />
  );
}
