import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { houseOptions } from "./houses";

const HOUSES = houseOptions();
const HOUSE_NAME_BY_MATCH = Object.fromEntries(HOUSES.map((h) => [h.matchHouse, h.name]));
const STATUSES = ["Draft", "Sent", "Active", "Expired", "Revoked"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function toDateInputValue(isoString) {
  return isoString ? isoString.slice(0, 10) : "";
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (loadingSession) return <Centered>Loading…</Centered>;
  if (!session) return <SignIn />;
  return <Dashboard session={session} />;
}

function Centered({ children }) {
  return <div className="centered">{children}</div>;
}

function SignIn() {
  const [error, setError] = useState(null);

  async function signIn() {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: { scopes: "email openid profile" },
    });
    if (error) setError(error.message);
  }

  return (
    <Centered>
      <div className="card">
        <h1>Goddijn Visit Manager</h1>
        <p>Sign in with your Goddijn Microsoft account to grant a guest access.</p>
        <button onClick={signIn}>Sign in with Microsoft</button>
        {error && <p className="error">{error}</p>}
      </div>
    </Centered>
  );
}

function Dashboard({ session }) {
  const [tab, setTab] = useState("visits"); // "visits" | "new"
  const [refreshKey, setRefreshKey] = useState(0);

  const creatorName =
    session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email;

  async function signOut() {
    await supabase.auth.signOut();
  }

  // Bumping this makes VisitsList refetch -- used after a new visit is
  // created on the "New visit" tab, so switching back to "Visits" shows it
  // without a manual page reload.
  function visitCreated() {
    setRefreshKey((k) => k + 1);
    setTab("visits");
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="header-row">
          <h1>Goddijn Visit Manager</h1>
          <button className="link" onClick={signOut}>
            Sign out ({creatorName})
          </button>
        </div>

        <div className="tab-row">
          <button className={tab === "visits" ? "tab active" : "tab"} onClick={() => setTab("visits")}>
            Who's staying where
          </button>
          <button className={tab === "new" ? "tab active" : "tab"} onClick={() => setTab("new")}>
            New visit
          </button>
        </div>

        {tab === "new" ? (
          <VisitForm session={session} onCreated={visitCreated} />
        ) : (
          <VisitsList session={session} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  );
}

function VisitForm({ session, onCreated }) {
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [house, setHouse] = useState(HOUSES[0]?.matchHouse ?? "");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { ok: true } | { ok: false, message }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/create-visit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ guestName, guestEmail, house, startDate, endDate, notes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setResult({ ok: true, guestEmail });
      setGuestName("");
      setGuestEmail("");
      setNotes("");
      onCreated?.();
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  const groupedHouses = [];
  for (const h of HOUSES) {
    let group = groupedHouses.find((g) => g.label === h.groupLabel);
    if (!group) {
      group = { label: h.groupLabel, houses: [] };
      groupedHouses.push(group);
    }
    group.houses.push(h);
  }

  return (
    <div className="card">
      <form onSubmit={handleSubmit}>
        <label>
          Guest name
          <input value={guestName} onChange={(e) => setGuestName(e.target.value)} required />
        </label>

        <label>
          Guest email
          <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} required />
        </label>

        <label>
          House
          <select value={house} onChange={(e) => setHouse(e.target.value)} required>
            {groupedHouses.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.houses.map((h) => (
                  <option key={h.matchHouse} value={h.matchHouse}>
                    {h.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="date-row">
          <label>
            Arrival
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label>
            Departure
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              required
            />
          </label>
        </div>

        <label>
          Notes (optional, internal only)
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>

        <button type="submit" disabled={submitting}>
          {submitting ? "Granting access…" : "Grant access & send invite"}
        </button>
      </form>

      {result?.ok && (
        <p className="success">
          Done — {result.guestEmail || "the guest"} can now sign in at{" "}
          <a href="https://www.goddijn.net">www.goddijn.net</a> for the dates given, and an invitation
          email is on its way.
        </p>
      )}
      {result && !result.ok && <p className="error">{result.message}</p>}
    </div>
  );
}

function VisitsList({ session, refreshKey }) {
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [showPast, setShowPast] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/list-visits", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setVisits(data.visits);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function handleRevoke(visit) {
    if (!window.confirm(`Revoke ${visit.guest_name}'s access to ${HOUSE_NAME_BY_MATCH[visit.house] || visit.house}?`)) {
      return;
    }
    try {
      const res = await fetch("/api/revoke-visit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ id: visit.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      await load();
    } catch (err) {
      window.alert(`Could not revoke: ${err.message}`);
    }
  }

  if (error) return <div className="card wide"><p className="error">{error}</p></div>;
  if (!visits) return <div className="card wide"><p>Loading visits…</p></div>;

  const now = new Date();
  const isPast = (v) => v.status === "Revoked" || v.status === "Expired" || new Date(v.end_date) < now;
  const visible = visits.filter((v) => showPast || !isPast(v));

  return (
    <div className="card wide">
      <div className="list-header">
        <p className="muted">
          {visible.length} {visible.length === 1 ? "visit" : "visits"} shown
        </p>
        <label className="checkbox-label">
          <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
          Show past / revoked
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="muted">No visits to show.</p>
      ) : (
        <table className="visits-table">
          <thead>
            <tr>
              <th>Guest</th>
              <th>House</th>
              <th>Arrival</th>
              <th>Departure</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((v) =>
              editingId === v.id ? (
                <EditRow
                  key={v.id}
                  visit={v}
                  session={session}
                  onDone={() => {
                    setEditingId(null);
                    load();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <tr key={v.id} className={isPast(v) ? "row-past" : ""}>
                  <td>
                    <div>{v.guest_name}</div>
                    <div className="muted small">{v.guest_email}</div>
                  </td>
                  <td>{HOUSE_NAME_BY_MATCH[v.house] || v.house}</td>
                  <td>{toDateInputValue(v.start_date)}</td>
                  <td>{toDateInputValue(v.end_date)}</td>
                  <td>
                    <span className={`status-badge status-${v.status.toLowerCase()}`}>{v.status}</span>
                  </td>
                  <td className="actions-cell">
                    <button className="link" onClick={() => setEditingId(v.id)}>
                      Edit
                    </button>
                    {v.status !== "Revoked" && (
                      <button className="link danger" onClick={() => handleRevoke(v)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EditRow({ visit, session, onDone, onCancel }) {
  const [guestName, setGuestName] = useState(visit.guest_name);
  const [guestEmail, setGuestEmail] = useState(visit.guest_email);
  const [house, setHouse] = useState(visit.house);
  const [startDate, setStartDate] = useState(toDateInputValue(visit.start_date));
  const [endDate, setEndDate] = useState(toDateInputValue(visit.end_date));
  const [status, setStatus] = useState(visit.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/update-visit", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          id: visit.id,
          guestName,
          guestEmail,
          house,
          startDate,
          endDate,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <tr className="row-editing">
      <td colSpan={6}>
        <div className="edit-grid">
          <label>
            Guest name
            <input value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </label>
          <label>
            Guest email
            <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
          </label>
          <label>
            House
            <select value={house} onChange={(e) => setHouse(e.target.value)}>
              {HOUSES.map((h) => (
                <option key={h.matchHouse} value={h.matchHouse}>
                  {h.groupLabel} — {h.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Arrival
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            Departure
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        {guestEmail !== visit.guest_email && (
          <p className="muted small">
            Changing the email grants {guestEmail || "the new address"} access too — it does not remove
            access from {visit.guest_email}. Use Revoke on the old visit separately if needed.
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="edit-actions">
          <button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="link" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
