import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { houseOptions as staticHouseOptions, PROPERTIES } from "./houses";

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
  const [tab, setTab] = useState("visits"); // "visits" | "new" | "creds"
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
          <button className={tab === "creds" ? "tab active" : "tab"} onClick={() => setTab("creds")}>
            Credentials
          </button>
        </div>

        {tab === "new" ? (
          <VisitForm session={session} houses={houses} onCreated={visitCreated} />
        ) : tab === "creds" ? (
          <CredentialsDashboard session={session} houses={houses} />
        ) : (
          <VisitsList session={session} houses={houses} refreshKey={refreshKey} />
        )}
      </div>
    </div>
  );
}

function VisitForm({ session, houses, onCreated }) {
  // Visit type: "day" or "house"
  const [visitType, setVisitType] = useState("house");

  // Guest list: each entry is { guestName, guestEmail, websiteAccess }
  const [guests, setGuests] = useState([
    { guestName: "", guestEmail: "", websiteAccess: false },
  ]);

  // Destination: property dropdown, then optional house dropdown
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [house, setHouse] = useState("");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [calendarAdd, setCalendarAdd] = useState(false);

  // Fetch email templates on mount
  useEffect(() => {
    fetch("/api/email-templates", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.templates) setTemplates(data.templates); })
      .catch(() => {});
  }, [session]);

  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  const [selectedVisitorId, setSelectedVisitorId] = useState(null);
  const [allVisitors, setAllVisitors] = useState([]);
  const [nameSuggestions, setNameSuggestions] = useState([]);
  const [nameActiveSuggestion, setNameActiveSuggestion] = useState(-1);

  useEffect(() => {
    fetch("/api/2n-visitors", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.visitors) setAllVisitors(data.visitors); })
      .catch(() => {});
  }, [session]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || null;
  const defaultTemplateType = visitType === "day" ? "door_only" : "invitation";
  const fallbackTemplate = templates.find((t) => t.template_type === defaultTemplateType && t.is_default) || null;
  const previewTemplate = selectedTemplate || fallbackTemplate;

  function updateGuest(index, field, value) {
    setGuests((prev) => prev.map((g, i) => (i === index ? { ...g, [field]: value } : g)));
    if (index === 0 && field === "guestName") {
      const q = value.trim().toLowerCase();
      if (q.length >= 1) {
        const matches = allVisitors.filter((v) => v.name && v.name.toLowerCase().includes(q)).slice(0, 6);
        setNameSuggestions(matches);
        setNameActiveSuggestion(-1);
      } else {
        setNameSuggestions([]);
        setNameActiveSuggestion(-1);
      }
    }
  }

  function selectVisitorSuggestion(v) {
    setGuests((prev) => prev.map((g, i) => (i === 0 ? { ...g, guestName: v.name || "", guestEmail: v.email || "" } : g)));
    setNameSuggestions([]);
    setNameActiveSuggestion(-1);
    setSelectedVisitorId(v.id);
  }

  function addGuest() {
    setGuests((prev) => [...prev, { guestName: "", guestEmail: "", websiteAccess: false }]);
  }

  function removeGuest(index) {
    setGuests((prev) => prev.filter((_, i) => i !== index));
  }

  function selectVisitType(type) {
    setVisitType(type);
    if (type === "day") {
      const today = todayISO();
      setStartDate(today);
      setEndDate(today);
    }
    // Reset destination and website access on type change
    setSelectedPropertyId("");
    setHouse("");
    setGuests((prev) => prev.map((g) => ({ ...g, websiteAccess: false })));
  }

  function selectProperty(propId) {
    setSelectedPropertyId(propId);
    const prop = PROPERTIES.find((p) => p.id === propId);
    if (!prop) return;
    if (visitType === "day") {
      // Day visitor: if property has one domain, use the first house's
      // matchHouse (so the server can resolve the 2N group). The UI shows
      // the property name, but we send a real house name.
      if (prop.domains.length === 1) {
        const firstHouse = prop.domains[0].houses[0];
        if (firstHouse) setHouse(firstHouse.matchHouse);
      } else {
        // Multi-domain (Mougins): don't auto-select, show estate selector
        setHouse("");
      }
    } else {
      // House guest: auto-select first house
      const firstHouse = prop.domains.flatMap((d) => d.houses)[0];
      if (firstHouse) setHouse(firstHouse.matchHouse);
    }
  }

  // For day visitors at multi-domain properties (Mougins): show domain selector.
  // When a domain is selected, set house to the first house in that domain
  // (the server resolves the 2N group from it). The UI label shows the domain name.
  const propertyDomains = selectedPropertyId
    ? PROPERTIES.find((p) => p.id === selectedPropertyId)?.domains || []
    : [];

  function selectDomain(domainId) {
    const prop = PROPERTIES.find((p) => p.id === selectedPropertyId);
    const domain = prop?.domains.find((d) => d.id === domainId);
    if (domain?.houses?.[0]) {
      setHouse(domain.houses[0].matchHouse);
    }
  }

  // Get the domain name for display from the currently selected house
  const selectedDomainName = (() => {
    if (!selectedPropertyId || !house) return "";
    const prop = PROPERTIES.find((p) => p.id === selectedPropertyId);
    for (const d of prop?.domains || []) {
      if (d.houses.some((h) => h.matchHouse === house)) return d.name;
    }
    return "";
  })();

  // Houses available within the selected property (for house guest mode)
  const propertyHouses = selectedPropertyId
    ? PROPERTIES.find((p) => p.id === selectedPropertyId)?.domains.flatMap((d) =>
        d.houses.map((h) => ({ ...h, domainLabel: d.name }))) || []
    : [];

  function resetForm() {
    setGuests([{ guestName: "", guestEmail: "", websiteAccess: false }]);
    setSelectedVisitorId(null);
    setSelectedTemplateId("");
    setSelectedPropertyId("");
    setHouse("");
    setCalendarAdd(false);
  }

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
        body: JSON.stringify({
          guests: guests.map((g) => ({
            guestName: g.guestName,
            guestEmail: g.guestEmail,
            websiteAccess: visitType === "day" ? false : g.websiteAccess,
          })),
          house, startDate, endDate,
          visitType,
          templateId: selectedTemplateId || undefined,
          existingVisitorId: selectedVisitorId || undefined,
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
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  function renderPreview(template) {
    if (!template) return "No template selected.";
    let body = template.body || "";
    const firstGuest = guests[0] || {};
    const replacements = {
      guestName: firstGuest.guestName || "[guest name]",
      houseName: houses.find((h) => h.matchHouse === house)?.name || house || "[house]",
      house: houses.find((h) => h.matchHouse === house)?.name || house || "[house]",
      doorCode: "[auto-generated]",
      startDate: startDate || "[arrival]",
      endDate: endDate || "[departure]",
      creatorName: session.user.user_metadata?.full_name || session.user.email || "[your name]",
    };
    body = body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return key in replacements ? replacements[key] : match;
    });
    return body;
  }

  return (
    <div className="card">
      <form onSubmit={handleSubmit}>
        {/* Visit type cards */}
        <div className="visit-type-cards">
          <button
            type="button"
            className={`visit-type-card ${visitType === "day" ? "selected" : ""}`}
            onClick={() => selectVisitType("day")}
          >
            <div className="visit-type-card-title">Day Visitor</div>
            <div className="visit-type-card-desc">Comes for the day. Door PIN only, no website access.</div>
          </button>
          <button
            type="button"
            className={`visit-type-card ${visitType === "house" ? "selected" : ""}`}
            onClick={() => selectVisitType("house")}
          >
            <div className="visit-type-card-title">House Guest</div>
            <div className="visit-type-card-desc">Stays overnight. Door PIN + optional website access.</div>
          </button>
        </div>

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
            <label className="autocomplete-label">
              {idx === 0 ? "Guest name" : ""}
              <input
                value={g.guestName}
                onChange={(e) => updateGuest(idx, "guestName", e.target.value)}
                onBlur={() => setTimeout(() => idx === 0 && setNameSuggestions([]), 200)}
                onKeyDown={(e) => {
                  if (idx === 0 && nameSuggestions.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setNameActiveSuggestion((p) => Math.min(p + 1, nameSuggestions.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setNameActiveSuggestion((p) => Math.max(p - 1, -1));
                    } else if (e.key === "Enter" && nameActiveSuggestion >= 0) {
                      e.preventDefault();
                      selectVisitorSuggestion(nameSuggestions[nameActiveSuggestion]);
                    }
                  }
                }}
                required
              />
              {idx === 0 && nameSuggestions.length > 0 && (
                <ul className="autocomplete-dropdown">
                  {nameSuggestions.map((v, si) => (
                    <li
                      key={v.id}
                      className={si === nameActiveSuggestion ? "active" : ""}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectVisitorSuggestion(v);
                      }}
                    >
                      <strong>{v.name}</strong>
                      {v.email && <span className="muted small"> · {v.email}</span>}
                      {v.pin && <span className="muted small"> · PIN {v.pin}</span>}
                      {v.visitTo && <span className="muted small"> · until {v.visitTo.slice(0, 10)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </label>
            <label>
              {idx === 0 ? "Guest email" : ""}
              <input
                type="email"
                value={g.guestEmail}
                onChange={(e) => updateGuest(idx, "guestEmail", e.target.value)}
                required
              />
            </label>
          </div>
        ))}

        {visitType === "house" && (
          <button type="button" className="link add-guest-btn" onClick={addGuest}>
            + Add another guest (family visit)
          </button>
        )}

        {/* Dates */}
        <div className="date-row">
          <label>
            Arrival
            <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setEndDate(e.target.value); }} required />
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

        {/* Destination: property dropdown, then optional house dropdown */}
        <label>
          Property
          <select
            value={selectedPropertyId}
            onChange={(e) => selectProperty(e.target.value)}
            required
          >
            <option value="">Select a property</option>
            {PROPERTIES.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        {visitType === "house" && selectedPropertyId && propertyHouses.length > 1 && (
          <label>
            House
            <select value={house} onChange={(e) => setHouse(e.target.value)} required>
              {propertyHouses.map((h) => (
                <option key={h.matchHouse} value={h.matchHouse}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {visitType === "day" && selectedPropertyId && propertyDomains.length > 1 && (
          <label>
            Which estate
            <select
              value={selectedDomainName || ""}
              onChange={(e) => {
                const domain = propertyDomains.find((d) => d.name === e.target.value);
                if (domain) selectDomain(domain.id);
              }}
              required
            >
              <option value="">Select an estate</option>
              {propertyDomains.map((d) => (
                <option key={d.id} value={d.name}>{d.name}</option>
              ))}
            </select>
          </label>
        )}

        {/* Website access toggle — appears after destination is selected */}
        {visitType === "house" && house && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={guests[0]?.websiteAccess || false}
              onChange={(e) => setGuests((prev) => prev.map((g, i) => (i === 0 ? { ...g, websiteAccess: e.target.checked } : g)))}
            />
            Website access (www.goddijn.net)
          </label>
        )}

        {templates.length > 0 && (
          <label>
            Email template
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
            >
              <option value="">Default for {visitType === "day" ? "day visitor" : "house guest"}</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Email preview */}
        {previewTemplate && (
          <details className="email-preview">
            <summary>Preview email (subject: {previewTemplate.subject})</summary>
            <div
              className="email-preview-body"
              dangerouslySetInnerHTML={{ __html: renderPreview(previewTemplate) }}
            />
          </details>
        )}

        {/* Calendar checkbox (placeholder) */}
        <label className="calendar-checkbox">
          <input
            type="checkbox"
            checked={calendarAdd}
            onChange={(e) => setCalendarAdd(e.target.checked)}
          />
          Add this stay to the Calendar
        </label>

        <div className="sticky-submit">
          <button type="submit" disabled={submitting}>
            {submitting
              ? "Processing…"
              : visitType === "day"
              ? "Send day visitor invite"
              : guests.length > 1
              ? `Send invites (${guests.length} guests)`
              : "Send invite"}
          </button>
        </div>
      </form>

      {result?.ok && (
        <p className="success">
          {visitType === "day"
            ? <>Done — the day visitor\'s entry code and address are on their way by email.</>
            : result.count > 1
            ? <>Done — {result.count} guests processed. Each receives their own PIN and invitation email.</>
            : <>Done — the guest can now sign in at <a href="https://www.goddijn.net">www.goddijn.net</a> for the dates given, and an invitation email is on its way.</>}
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
  const [revokeTarget, setRevokeTarget] = useState(null); // { visit, revokeAll } or null

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

  function handleRevoke(visit, revokeAll = false) {
    setRevokeTarget({ visit, revokeAll });
  }

  async function confirmRevoke(deleteVisitor) {
    if (!revokeTarget) return;
    const { visit, revokeAll } = revokeTarget;
    setRevokeTarget(null);
    try {
      const res = await fetch("/api/revoke-visit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(
          revokeAll
            ? { visitGroupId: visit.visit_group_id, deleteVisitor }
            : { id: visit.id, deleteVisitor }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (data.twoNError) {
        window.alert(`Visit revoked in the app, but the 2N door update failed: ${data.twoNError}\n\nThe visitor's PIN may still be active. You may need to adjust it manually in the 2N Access Commander console.`);
      }
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

      {revokeTarget && (
        <RevokeModal
          visit={revokeTarget.visit}
          revokeAll={revokeTarget.revokeAll}
          houses={houses}
          onConfirm={confirmRevoke}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

function RevokeModal({ visit, revokeAll, houses, onConfirm, onCancel }) {
  const houseName = houses.find((h) => h.matchHouse === visit.house)?.name || visit.house;
  const who = revokeAll
    ? `all guests in the family visit to ${houseName}`
    : `${visit.guest_name}'s access to ${houseName}`;
  const hasDoor = !!visit.ac_visitor_id || !!visit.door_code;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Revoke access</h2>
        <p className="muted">You are about to revoke {who}.</p>

        <div className="revoke-effects">
          <p className="muted small">This will always:</p>
          <ul className="muted small">
            <li>Mark the visit as Revoked</li>
            <li>Remove website access (www.goddijn.net)</li>
          </ul>
        </div>

        {hasDoor ? (
          <>
            <p className="modal-label">Door access (2N PIN):</p>
            <div className="revoke-options">
              <button
                className="revoke-option"
                onClick={() => onConfirm(false)}
              >
                <strong>Revoke Access, keep visitor</strong>
                <span className="muted small">Visiting window ends now — PIN can't open doors. Visitor and PIN stay in 2N for quick re-extension next time.</span>
              </button>
              <button
                className="revoke-option revoke-option-danger"
                onClick={() => onConfirm(true)}
              >
                <strong>Delete visitor entirely</strong>
                <span className="muted small">PIN is gone. A new visitor + PIN will be created next time they visit.</span>
              </button>
            </div>
          </>
        ) : (
          <button className="revoke-option" onClick={() => onConfirm(false)}>
            <strong>Confirm revoke</strong>
            <span className="muted small">No door access to clean up.</span>
          </button>
        )}

        <button className="link modal-cancel" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function CredentialsDashboard({ session, houses }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [debugInfo, setDebugInfo] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [visitorsRes, cfRes, visitsRes] = await Promise.all([
        fetch("/api/2n-visitors", { headers: { Authorization: `Bearer ${session.access_token}` } }),
        fetch("/api/cloudflare-guests", { headers: { Authorization: `Bearer ${session.access_token}` } }),
        fetch("/api/list-visits", { headers: { Authorization: `Bearer ${session.access_token}` } }),
      ]);

      const visitorsData = await visitorsRes.json();
      const cfData = await cfRes.json();
      const visitsData = await visitsRes.json();

      // If 2N visitors returned empty or errored, fetch debug info
      if (!visitorsRes.ok || (visitorsData.visitors || []).length === 0) {
        try {
          const dbgRes = await fetch("/api/2n-debug", { headers: { Authorization: `Bearer ${session.access_token}` } });
          const dbgData = await dbgRes.json();
          setDebugInfo(dbgData);
        } catch (e) {
          setDebugInfo({ error: e.message });
        }
      }

      if (!visitorsRes.ok) throw new Error(visitorsData.error || "Failed to fetch 2N visitors");
      if (!cfRes.ok) throw new Error(cfData.error || "Failed to fetch Cloudflare guests");
      if (!visitsRes.ok) throw new Error(visitsData.error || "Failed to fetch visits");

      // Build a map keyed by email (lowercased)
      const map = new Map();

      // 2N visitors → door access
      for (const v of visitorsData.visitors || []) {
        if (!v.email) continue;
        const key = v.email.toLowerCase();
        if (!map.has(key)) map.set(key, { email: key, name: v.name, doorPin: null, doorExpiry: null, doorGroups: [], website: false, house: null, visitStatus: null });
        const row = map.get(key);
        row.name = row.name || v.name;
        row.doorPin = v.pin || row.doorPin;
        row.doorExpiry = v.visitTo || row.doorExpiry;
        row.doorGroups = v.groups || row.doorGroups;
      }

      // Cloudflare guests → website access
      for (const g of cfData.emails || []) {
        const key = g.email.toLowerCase();
        if (!map.has(key)) map.set(key, { email: key, name: null, doorPin: null, doorExpiry: null, doorGroups: [], website: true, house: null, visitStatus: null });
        map.get(key).website = true;
      }

      // Directus visits → metadata
      for (const v of visitsData.visits || []) {
        const key = (v.guest_email || "").toLowerCase();
        if (!key) continue;
        if (!map.has(key)) map.set(key, { email: key, name: v.guest_name, doorPin: null, doorExpiry: null, doorGroups: [], website: false, house: null, visitStatus: null });
        const row = map.get(key);
        row.name = row.name || v.guest_name;
        row.house = v.house;
        row.visitStatus = v.status;
        if (v.door_code && !row.doorPin) row.doorPin = v.door_code;
      }

      const now = new Date();
      const allRows = Array.from(map.values()).map((r) => ({
        ...r,
        doorActive: r.doorExpiry && new Date(r.doorExpiry) >= now,
        houseName: houses.find((h) => h.matchHouse === r.house)?.name || r.house,
      }));

      // Sort: active first, then by name
      allRows.sort((a, b) => {
        if (a.doorActive !== b.doorActive) return a.doorActive ? -1 : 1;
        return (a.name || a.email).localeCompare(b.name || b.email);
      });

      setRows(allRows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="card wide"><p>Loading credentials…</p></div>;
  if (error) return <div className="card wide"><p className="error">{error}</p></div>;

  const activeDoor = rows.filter((r) => r.doorActive).length;
  const activeWeb = rows.filter((r) => r.website).length;
  const expired = rows.filter((r) => r.doorExpiry && !r.doorActive).length;

  return (
    <div className="card wide">
      <div className="creds-summary">
        <span className="status-badge status-active">{activeDoor} active door codes</span>
        <span className="status-badge status-active">{activeWeb} website accesses</span>
        {expired > 0 && <span className="status-badge status-expired">{expired} expired</span>}
      </div>

      {debugInfo && (
        <div className="debug-panel">
          <p className="muted small"><strong>2N API debug:</strong></p>
          <pre className="debug-pre">{JSON.stringify(debugInfo, null, 2)}</pre>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="muted">No credentials found.</p>
      ) : (
        <table className="visits-table">
          <thead>
            <tr>
              <th>Guest</th>
              <th>Door access</th>
              <th>Website</th>
              <th>House</th>
              <th>Visit status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.email} className={r.doorExpiry && !r.doorActive ? "row-past" : ""}>
                <td>
                  <div>{r.name || "—"}</div>
                  <div className="muted small">{r.email}</div>
                </td>
                <td>
                  {r.doorExpiry ? (
                    <>
                      <span className={r.doorActive ? "status-badge status-active" : "status-badge status-expired"}>
                        {r.doorActive ? "Active" : "Expired"}
                      </span>
                      {r.doorPin && <div className="muted small">PIN: {r.doorPin}</div>}
                      <div className="muted small">until {r.doorExpiry.slice(0, 10)}</div>
                      {r.doorGroups?.length > 0 && <div className="muted small">{r.doorGroups.map((g) => g.name).join(", ")}</div>}
                    </>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
                <td>
                  {r.website ? (
                    <span className="status-badge status-active">Yes</span>
                  ) : (
                    <span className="muted small">No</span>
                  )}
                </td>
                <td>{r.houseName || "—"}</td>
                <td>
                  {r.visitStatus ? (
                    <span className={`status-badge status-${r.visitStatus.toLowerCase()}`}>{r.visitStatus}</span>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
              </tr>
            ))}
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
