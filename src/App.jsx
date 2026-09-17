import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { houseOptions as staticHouseOptions } from "./houses";

const STATIC_HOUSES = staticHouseOptions();
const STATUSES = ["Draft", "Sent", "Active", "Expired", "Revoked"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function toDateInputValue(isoString) {
  return isoString ? isoString.slice(0, 10) : "";
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [houses, setHouses] = useState(STATIC_HOUSES);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Fetch houses from the API (Directus-backed) on mount. Falls back to
  // the static copy in houses.js if the API is unreachable.
  useEffect(() => {
    fetch("/api/houses")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.options?.length) setHouses(data.options);
      })
      .catch(() => {/* keep static fallback */});
  }, []);

  if (loadingSession) return <Centered>Loading…</Centered>;
  if (!session) return <SignIn />;
  return <Dashboard session={session} houses={houses} />;
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

function Dashboard({ session, houses }) {
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
          <VisitForm session={session} houses={houses} onCreated={visitCreated} />
        ) : (
          <VisitsList session={session} houses={houses} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  );
}

function VisitForm({ session, houses, onCreated }) {
  // Guest list: each entry is { guestName, guestEmail, websiteAccess }
  const [guests, setGuests] = useState([
    { guestName: "", guestEmail: "", websiteAccess: true },
  ]);
  const [house, setHouse] = useState(houses[0]?.matchHouse ?? "");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [doorCode, setDoorCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  // Existing-visitor lookup state (Phase 2) — applies to the first guest only
  const [existingVisitors, setExistingVisitors] = useState(null);
  const [searching, setSearching] = useState(false);
  const [extendMode, setExtendMode] = useState(null);

  function updateGuest(index, field, value) {
    setGuests((prev) => prev.map((g, i) => (i === index ? { ...g, [field]: value } : g)));
  }

  function addGuest() {
    setGuests((prev) => [...prev, { guestName: "", guestEmail: "", websiteAccess: true }]);
  }

  function removeGuest(index) {
    setGuests((prev) => prev.filter((_, i) => i !== index));
  }

  async function lookupGuestByEmail(email) {
    if (!email || !EMAIL_RE.test(email.trim())) return;
    setSearching(true);
    setExistingVisitors(null);
    try {
      const res = await fetch("/api/2n-visitors", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const matches = (data.visitors || []).filter(
        (v) => v.email && v.email.toLowerCase() === email.trim().toLowerCase()
      );
      setExistingVisitors(matches);
    } catch (err) {
      setExistingVisitors([]);
    } finally {
      setSearching(false);
    }
  }

  function resetForm() {
    setGuests([{ guestName: "", guestEmail: "", websiteAccess: true }]);
    setNotes("");
    setDoorCode("");
    setExtendMode(null);
    setExistingVisitors(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      if (extendMode && guests.length === 1) {
        // Extend path: single guest extending an existing 2N visitor
        const g = guests[0];
        const res = await fetch("/api/extend-visit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            visitorId: extendMode,
            guestName: g.guestName, guestEmail: g.guestEmail,
            house, startDate, endDate, notes,
            websiteAccess: g.websiteAccess,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        setResult({ ok: true, guestEmail: g.guestEmail, extended: true });
        resetForm();
        onCreated?.();
      } else {
        // Create-new path: send all guests to create-visit
        const res = await fetch("/api/create-visit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            guests: guests.map((g) => ({
              guestName: g.guestName,
              guestEmail: g.guestEmail,
              websiteAccess: g.websiteAccess,
            })),
            house, startDate, endDate, notes, doorCode,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        setResult({
          ok: true,
          count: data.results?.length || guests.length,
          results: data.results,
        });
        resetForm();
        onCreated?.();
      }
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  const groupedHouses = [];
  for (const h of houses) {
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
        {/* Guest list */}
        {guests.map((g, idx) => (
          <div key={idx} className="guest-row">
            {guests.length > 1 && (
              <div className="guest-row-header">
                <span className="muted small">Guest {idx + 1}</span>
                <button type="button" className="link danger" onClick={() => removeGuest(idx)}>
                  Remove
                </button>
              </div>
            )}
            <label>
              {idx === 0 ? "Guest name" : ""}
              <input
                value={g.guestName}
                onChange={(e) => updateGuest(idx, "guestName", e.target.value)}
                required
              />
            </label>
            <label>
              {idx === 0 ? "Guest email" : ""}
              <input
                type="email"
                value={g.guestEmail}
                onChange={(e) => updateGuest(idx, "guestEmail", e.target.value)}
                onBlur={(e) => idx === 0 && lookupGuestByEmail(e.target.value)}
                required
              />
            </label>
            {idx === 0 && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={g.websiteAccess}
                  onChange={(e) => updateGuest(idx, "websiteAccess", e.target.checked)}
                />
                Website access (www.goddijn.net)
              </label>
            )}
            {idx > 0 && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={g.websiteAccess}
                  onChange={(e) => updateGuest(idx, "websiteAccess", e.target.checked)}
                />
                Website access
              </label>
            )}
          </div>
        ))}

        {guests.length === 1 && searching && <p className="muted small">Checking for existing door access…</p>}

        {guests.length === 1 && existingVisitors && existingVisitors.length > 0 && (
          <div className="existing-visitor-panel">
            <p className="muted small">This person already has access in 2N:</p>
            {existingVisitors.map((v) => (
              <div key={v.id} className={`visitor-match ${extendMode === v.id ? "selected" : ""}`}>
                <span>
                  PIN: <strong>{v.pin || "on file"}</strong>
                  {v.visitTo && <> · valid until {v.visitTo.slice(0, 10)}</>}
                  {v.groups?.length > 0 && <> · {v.groups.map((gr) => gr.name).join(", ")}</>}
                </span>
                {extendMode === v.id ? (
                  <button type="button" className="link" onClick={() => setExtendMode(null)}>
                    Cancel extend
                  </button>
                ) : (
                  <button type="button" className="link" onClick={() => setExtendMode(v.id)}>
                    Extend this visitor
                  </button>
                )}
              </div>
            ))}
            <p className="muted small">
              {extendMode
                ? "Extending: the existing PIN stays the same, only the dates change."
                : "Choose a visitor to extend, or submit to create a new one."}
            </p>
          </div>
        )}

        {!extendMode && (
          <button type="button" className="link add-guest-btn" onClick={addGuest}>
            + Add another guest (family visit)
          </button>
        )}

        <label>
          House
          <select value={house} onChange={(e) => setHouse(e.target.value)} required>
            {groupedHouses.map((grp) => (
              <optgroup key={grp.label} label={grp.label}>
                {grp.houses.map((h) => (
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

        <label>
          Door code (optional)
          <input
            value={doorCode}
            onChange={(e) => setDoorCode(e.target.value)}
            placeholder="Leave blank to auto-generate via 2N Access Commander"
            maxLength={50}
          />
        </label>
        <p className="hint">
          {guests.length > 1
            ? `Each guest gets their own PIN and email. A shared group ID links them for easy management.`
            : `If you leave the door code blank, a 6-digit PIN is generated automatically via 2N Access Commander.`}
        </p>

        <button type="submit" disabled={submitting}>
          {submitting
            ? "Processing…"
            : extendMode
            ? "Extend access & send email"
            : guests.length > 1
            ? `Grant access & send invites (${guests.length} guests)`
            : "Grant access & send invite"}
        </button>
      </form>

      {result?.ok && (
        <p className="success">
          {result.extended
            ? <>Done — {result.guestEmail || "the guest"}'s access has been extended. An email is on its way with the updated dates.</>
            : result.count > 1
            ? <>Done — {result.count} guests processed. Each receives their own PIN and invitation email.</>
            : <>Done — the guest can now sign in at <a href="https://www.goddijn.net">www.goddijn.net</a> for the dates given, and an invitation email is on its way.</>
          }
        </p>
      )}
      {result && !result.ok && <p className="error">{result.message}</p>}
    </div>
  );
}

function VisitsList({ session, houses, refreshKey }) {
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

  async function handleRevoke(visit, revokeAll = false) {
    const houseName = houses.find((h) => h.matchHouse === visit.house)?.name || visit.house;
    const msg = revokeAll
      ? `Revoke access for ALL guests in this family visit to ${houseName}?`
      : `Revoke ${visit.guest_name}'s access to ${houseName}?`;
    if (!window.confirm(msg)) return;
    try {
      const res = await fetch("/api/revoke-visit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(revokeAll ? { visitGroupId: visit.visit_group_id } : { id: visit.id }),
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
                  houses={houses}
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
                  <td>
                    <div>{houses.find((h) => h.matchHouse === v.house)?.name || v.house}</div>
                    {v.door_code && <div className="muted small">Door code: {v.door_code}</div>}
                  </td>
                  <td>{toDateInputValue(v.start_date)}</td>
                  <td>{toDateInputValue(v.end_date)}</td>
                  <td>
                    <span className={`status-badge status-${v.status.toLowerCase()}`}>{v.status}</span>
                    {v.website_access === false && (
                      <span className="status-badge status-door-only" title="Door access only, no website">Door only</span>
                    )}
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
                    {v.status !== "Revoked" && v.visit_group_id &&
                     visits.filter((x) => x.visit_group_id === v.visit_group_id && x.status !== "Revoked").length > 1 && (
                      <button className="link danger" onClick={() => handleRevoke(v, true)}>
                        Revoke all
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

function EditRow({ visit, session, houses, onDone, onCancel }) {
  const [guestName, setGuestName] = useState(visit.guest_name);
  const [guestEmail, setGuestEmail] = useState(visit.guest_email);
  const [house, setHouse] = useState(visit.house);
  const [startDate, setStartDate] = useState(toDateInputValue(visit.start_date));
  const [endDate, setEndDate] = useState(toDateInputValue(visit.end_date));
  const [status, setStatus] = useState(visit.status);
  const [doorCode, setDoorCode] = useState(visit.door_code || "");
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
          doorCode,
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
              {houses.map((h) => (
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
          <label>
            Door code (optional)
            <input value={doorCode} onChange={(e) => setDoorCode(e.target.value)} maxLength={50} />
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
