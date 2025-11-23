// app.js - Smiles WhatsApp Bot - WORKING NOV 2025
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD = 5.8;

function brlToUsd(brl) {
  return Math.round(brl / BRL_TO_USD);
}

function to12h(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return `\( {h12}: \){m.toString().padStart(2, "0")}${period}`;
}

// CURRENT WORKING SMILES ENDPOINT - NOV 2025
async function searchSmilesAwards(origin, dest, dateISO) {
  const url = "https://flightsearch.smiles.com.br/search";

  const payload = {
    adults: 1,
    cabin: 0,
    children: 0,
    currencyCode: "BRL",
    departureDate: dateISO,
    destinationAirportCode: dest,
    infants: 0,
    isFlexibleDate: false,
    originAirportCode: origin,
    tripType: 1,
    forceCongener: false,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": "https://www.smiles.com.br",
        "Referer": "https://www.smiles.com.br/",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) return [];

    const data = await res.json();
    const flights = [];

    for (const f of data?.flights || []) {
      const fare = f.recommendedFare || {};
      const econ = fare.economy?.miles > 0 ? fare.economy.miles : null;
      const bus = fare.business?.miles > 0 ? fare.business.miles : null;
      const taxes = (fare.taxes || 0) / 100;

      if (econ || bus) {
        flights.push({
          airline: "GOL",
          originCode: f.departure.airportCode,
          destCode: f.arrival.airportCode,
          dep: f.departure.time.slice(0, 5),
          arr: f.arrival.time.slice(0, 5),
          econPts: econ,
          busPts: bus,
          taxesBRL: taxes,
        });
      }
    }
    return flights;
  } catch (e) {
    console.error("Smiles error:", e.message);
    return [];
  }
}

function buildResponse(flights, maxPoints = Infinity) {
  const valid = flights.filter(
    (f) => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints
  );

  if (valid.length === 0) return "No award space found under your max points.";

  let out = "";
  const groups = {};
  valid.forEach((f) => {
    const key = `\( {f.airline} \){f.originCode}`;
    groups[key] = groups[key] || [];
    groups[key].push(f);
  });

  for (const [title, list] of Object.entries(groups)) {
    out += `=== ${title} ===\n\n`;
    list.sort((a, b) => a.dep.localeCompare(b.dep));
    list.forEach((f) => {
      const dep = to12h(f.dep);
      const arr = to12h(f.arr);
      const econ = f.econPts ? f.econPts : "-";
      const bus = f.busPts ? f.busPts : "-";
      const taxes = f.taxesBRL ? brlToUsd(f.taxesBRL) : "-";
      const lowest = econ !== "-" ? econ : bus;

      out += `\( {f.originCode} \){dep} – \( {f.destCode} \){arr}\n`;
      out += `  Economy: \( {econ} | Business: \){bus}\n`;
      out += `  Points: ${lowest} + $${taxes} taxes\n\n`;
    });
  }
  return out.trim();
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const msg = (req.body.Body || "").trim().toUpperCase();
    const match = msg.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);

    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: JFK-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, originCity, dest, date, maxStr] = match;
    const max = maxStr ? Number(maxStr) : Infinity;
    const origins = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    let allFlights = [];
    for (const o of origins) {
      const flights = await searchSmilesAwards(o, dest, date);
      allFlights = allFlights.concat(flights);
    }

    const text = buildResponse(allFlights, max);

    res.type("text/xml").send(`
<Response>
  <Message>${text}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error(err);
    res.type("text/xml").send("<Response><Message>Sorry, try again later.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smiles Bot running on port ${PORT}`));
