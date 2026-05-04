// Consulta Redis para verificar si el email tiene suscripción activa
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email requerido" });

  try {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;

    const r = await fetch(
      `${url}/get/${encodeURIComponent(`sub:${email}`)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();

    if (!data.result) {
      return res.status(200).json({ active: false, reason: "No subscription found" });
    }

    const sub = JSON.parse(data.result);
    return res.status(200).json({
      active: sub.active === true,
      status: sub.status,
      trialEnd: sub.trialEnd,
    });
  } catch (err) {
    console.error("Error checking subscription:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
