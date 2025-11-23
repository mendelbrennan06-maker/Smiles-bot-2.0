// app.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD_RATE = 5.8;

/** Helpers */
function brlToUsd(brl) {
  return Number((brl / BRL_TO_USD_RATE).toFixed(0));
}

function ptsValueUsd(points) {
  if (points <= 20000) return points * 0.005;
  if (points <= 40000) return points * 0.0045;
  if (points <= 60000) return points * 0.0043;
  return points * 0.004;
}

function to12Hour(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return `\( {h12}: \){m.toString().padStart(2, "0")}${period}`;
}

/** Current working Smiles API – Nov 2025 */
async function searchSmilesAwards(origin, dest, dateISO) {
  const url = `https://api-air-flightsearch-green.smiles.com.br/v1/airlines/search?cabin=ALL&originAirportCode=\( {origin}&destinationAirportCode= \){dest}&departureDate=${dateISO}&adults=1&children=0&infants=0&forceCongener=false`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Referer": "https://www.smiles.com.br/",
      },
    });

    if (!res.ok) return [];

    const data = await res.json();
    const flights = [];

    for (const flight of data?.flights || []) {
      const { departure, arrival, airlineName = "GOL", recommendedFare } = flight;

      if (!recommendedFare) continue;

      const econPts = recommendedFare.economy?.miles > 0 ? recommendedFare.economy.miles : null;
      const busPts = recommendedFare.business?.miles > 0 ? recommendedFare.business.miles : null;
      const taxesBRL = recommendedFare.taxes / 100 || 0;

      if (econPts || busPts) {
        flights.push({
          airline: airlineName,
          originCode: departure.airportCode,
          destCode: arrival.airportCode,
          dep: departure.time.slice(0, 5),
          arr: arrival.time.slice(0, 5),
          econPts,
          busPts,
          taxesBRL,
        });
      }
    }
    return flights;
  } catch (e) {
    console.error("Smiles API error:", e.message);
    return [];
  }
}

/** Response builder */
function buildResponse({ flights, maxPoints = Infinity }) {
  const valid = flights.filter(f => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints);
  if (valid.length === 0) return "No award space found under your max points.";

  let out = "";
  const groups = {};
  valid.forEach(f => {
    const key = `\( {f.airline} from \){f.originCode}`;
    groups[key] = groups[key] || [];
    groups[key].push(f);
  });

  for (const [title, list] of Object.entries(groups)) {
    out += `=== ${title} ===\n\n`;
    list.sort((a, b) => a.dep.localeCompare(b.dep));
    list.forEach(f => {
      const dep12 = to12Hour(f.dep);
      const arr12 = to12Hour(f.arr);
      const econ = f.econPts ? f.econPts : "-";
      const bus = f.busPts ? f.busPts : "-";
      const taxes = f.taxesBRL ? brlToUsd(f.taxesBRL) : "-";
      const lowest = econ !== "-" ? econ : bus;

      out += `\( {f.originCode} \){dep12} – \( {f.destCode} \){arr12}\n`;
      out += `  Economy: \( {econ} | Business: \){bus}\n`;
      out += `  1=${lowest} pts  2=\[ {taxes} taxes\n`;
      if (f.econPts) out += `    (≈ \]{ptsValueUsd(f.econPts).toFixed(2)} value)\n`;
      if (f.busPts) out += `    (≈ $${ptsValueUsd(f.busPts).toFixed(2)} value)\n\n`;
    });
  }
  return out.trim();
}

/** WhatsApp webhook */
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim().toUpperCase();
    const match = incoming.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: JFK-GRU 2025-12-20 max=40000</Message></Response>");
    }

    const [, originCity, dest, dateISO, maxStr] = match;
    const maxPoints = maxStr ? Number(maxStr) : Infinity;
    const origins = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    let allFlights = [];
    for (const o of origins) {
      const flights = await searchSmilesAwards(o, dest, dateISO);
      allFlights.push(...flights);
    }

    const text = buildResponse({ flights: allFlights, maxPoints }) || "No award space found.";

    res.type("text/xml").send(`
<Response>
  <Message>${text}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error(err);
    res.type("text/xml").send("<Response><Message>Sorry, something went wrong.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smiles bot running on port ${PORT}`));
