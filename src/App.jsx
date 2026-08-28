import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { houseOptions } from "./houses";

const HOUSES = houseOptions();

function todayISO() {
  return new Date().toISOString().slice(0, 10);
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
  return <VisitForm session={session} />;
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

function VisitForm({ session }) {
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [house, setHouse] = useState(HOUSES[0]?.matchHouse ?? "");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { ok: true } | { ok: false, message }

  const creatorName =
    session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.email;

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
      setResult({ ok: true });
      setGuestName("");
      setGuestEmail("");
      setNotes("");
    } catch (err) {
      setResult({ ok: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
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
    <Centered>
      <div className="card">
        <div className="header-row">
          <h1>Goddijn Visit Manager</h1>
          <button className="link" onClick={signOut}>
            Sign out ({creatorName})
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label>
            Guest name
            <input value={guestName} onChange={(e) => setGuestName(e.target.value)} required />
          </label>

          <label>
            Guest email
            <input
              type="email"
              value={guestEmail}
              onChange={(e) => setGuestEmail(e.target.value)}
              required
            />
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
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
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
            Done — {guestEmail || "the guest"} can now sign in at{" "}
            <a href="https://www.goddijn.net">www.goddijn.net</a> for the dates given, and an
            invitation email is on its way.
          </p>
        )}
        {result && !result.ok && <p className="error">{result.message}</p>}
      </div>
    </Centered>
  );
}
