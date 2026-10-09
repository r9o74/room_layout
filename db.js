// Saved layouts in Supabase (table: public.layouts), via its REST API.
// The publishable key is meant to be public; access is limited by RLS (anyone can read / create / update, nobody can delete).
window.LayoutDB = (() => {
  const URL = "https://neuibvaqsepriklfilbc.supabase.co/rest/v1/layouts";
  const KEY = "sb_publishable_ztzBaORQRcOeYdsHJqvwTQ_Lj_iCOgp";
  const COLS = "id,no,name,author,data,created_at,updated_at";

  async function req(query, opts = {}) {
    const res = await fetch(URL + query, {
      ...opts,
      headers: { apikey: KEY, "Content-Type": "application/json", Prefer: "return=representation", ...opts.headers }
    });
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const j = await res.json(); if (j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  return {
    list: () => req(`?select=${COLS}&order=updated_at.desc&limit=200`),
    // Number the next default name would get ("レイアウト<no>"); the server assigns the real one.
    nextNo: async () => { const r = await req("?select=no&order=no.desc&limit=1"); return r.length ? r[0].no + 1 : 1; },
    create: async (name, author, data) => (await req(`?select=${COLS}`, { method: "POST", body: JSON.stringify({ name, author, data }) }))[0],
    // Returns null when someone else updated it after `since` (unless since is null = force overwrite).
    update: async (id, fields, since) => {
      const guard = since ? `&updated_at=eq.${encodeURIComponent(since)}` : "";
      const r = await req(`?id=eq.${encodeURIComponent(id)}${guard}&select=${COLS}`, { method: "PATCH", body: JSON.stringify(fields) });
      return r[0] || null;
    }
  };
})();
