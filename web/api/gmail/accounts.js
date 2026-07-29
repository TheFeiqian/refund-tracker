// GET  → { accounts:[email, ...] } list of connected Gmail accounts (emails only, no tokens).
// DELETE ?email=... → disconnect an account.
const { listAccounts, deleteAccount } = require('./_util');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const email = url.searchParams.get('email');
      if (email) await deleteAccount(email);
      return res.status(200).json({ ok: true });
    }
    const accounts = await listAccounts();
    return res.status(200).json({ accounts });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e), accounts: [] });
  }
};
