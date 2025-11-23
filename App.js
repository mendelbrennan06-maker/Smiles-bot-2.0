// app.js
import express from "express";
import fetch from "node-fetch"; // npm i node-fetch@2.6.7 if using CommonJS, or use native fetch in Node 18+

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD_RATE = 5.28;

/**
 * Helpers
 */
function brlToUsd(brl) {
  return Number((brl / BRL_TO_USD_RATE).toFixed(2));
}

function ptsValueUsd(points) {
  if (points <= 20000) return points * 0.005;
  if (points <= 40000) return points * 0.0045;
  if (points <= 60000) return points * 0.0043;
  return points * 0.004;
}

function to12Hour(time24) {
  if (!time24) return "";
  const [hh, mm] = time24.split(":").map(Number);
  const period = hh >= 12 ? "pm" : "am";
  const hh12 = hh % 12 || 12;
  return `\( {hh12}: \){String(mm).padStart(2, "0")}${period}`;
}

/**
 * Real Smiles API scraper (Nov 2025 working endpoint)
 */
async function searchSmilesAwards(origin, dest, dateISO) {
  const payload = {
    adults: 1,
    cabinType: "ALL",
    children: 0,
    departureDate: dateISO,
    destinationAirportCode: dest,
    infants: 0,
    isFlexibleDate: false,
    originAirportCode: origin,
    tripType: "OW",
    currencyCode: "BRL",
  };

  const res = await fetch("https://www.smiles.com.br/mfe/api/v2/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://www.smiles.com.br",
      "Referer": "https://www.smiles.com.br/emissao-passagem",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "x-app": "mfe",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Smiles API error ${res.status}`);
  }

  const data = await res.json();
  const flights = [];

  for (const seg of data?.requestedFlightSegmentList || []) {
    const { departure, arrival, airlineName } = seg;

    let econPts = null;
    let busPts = null;
    let taxesBRL = null;

    for (const fare of seg.fareOptions || []) {
      const points = fare.miles || fare.points || 0;
      const money = fare.money || fare.taxes || 0; // comes in cents (reais)
      const taxes = money / 100;

      const isBusiness =
        fare.cabin === "BUSINESS" ||
        fare.classOfService?.toUpperCase().includes("J") ||
        fare.cabinType === "BUSINESS";

      if (isBusiness) {
        busPts = points;
        taxesBRL = taxes;
      } else {
        econPts = points;
        taxesBRL = taxes;
      }
    }

    if (econPts !== null || busPts !== null) {
      flights.push({
        airline: airlineName || "Unknown",
        originCode: departure.airportCode,
        destCode: arrival.airportCode,
        dep: departure.time?.slice(0, 5) || "",
        arr: arrival.time?.slice(0, 5) || "",
        depDate: departure.date,
        econPts: econPts,
        busPts: busPts,
        taxesBRL,
      });
    }
  }

  return flights;
}

/**
 * Build the exact response format you love
 */
function buildResponse({ flights, maxPoints = Infinity }) {
  const valid = flights.filter(
    (f) => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints
  );

  const both = valid.filter((f) => f.econPts && f.busPts);
  const econOnly = valid.filter((f) => f.econPts && !f.busPts);
  const busOnly = valid.filter((f) => !f.econPts && f.busPts);

  function sortByDep(arr) {
    return arr.sort((a, b) => a.dep.localeCompare(b.dep));
  }

  const sections = [
    { title: "Both Economy & Business", items: sortByDep(both) },
    { title: "Economy only", items: sortByDep(econOnly) },
    { title: "Business only", items: sortByDep(busOnly) },
  ];

  let out = "";

  sections.forEach((sec) => {
    if (!sec.items.length) return;
    out += `=== ${sec.title} ===\n`;

    const byOriginAirline = {};
    sec.items.forEach((f) => {
      const key = `\( {f.originCode}- \){f.airline}`;
      byOriginAirline[key] = byOriginAirline[key] || [];
      byOriginAirline[key].push(f);
    });

    Object.entries(byOriginAirline).forEach(([key, list]) => {
      const [origin, airline] = key.split("-");
      out += `\n\( {airline} from \){origin}:\n`;
      list.forEach((f) => {
        const dep12 = to12Hour(f.dep);
        const arr12 = to12Hour(f.arr);
        const econ = f.econPts ? `${f.econPts}` : "-";
        const bus = f.busPts ? `${f.busPts}` : "-";
        const taxesUSD = f.taxesBRL ? brlToUsd(f.taxesBRL).toFixed(0) : "-";
        const lowestPts = econ !== "-" ? econ : bus;

        out += `\( {origin} \){dep12} - \( {f.destCode} \){arr12}\n`;
        out += `  Economy pts: \( {econ} | Business pts: \){bus}\n`;
        out += `  1=${lowestPts} (points)  2=\[ {taxesUSD} (USD taxes)\n`;
        if (f.econPts)
          out += `    (points value est: \]{ptsValueUsd(f.econPts).toFixed(2)})\n`;
        if (f.busPts)
          out += `    (points value est: $${ptsValueUsd(f.busPts).toFixed(2)})\n`;
      });
    });
    out += "\n";
  });

  return out || "No award space found under your max points.";
}

/**
 * Twilio WhatsApp webhook
 */
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim().toUpperCase();

    // Parse: NYC-YYZ 2025-12-15 max=30000
    const match = incoming.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/plain").send("Format: NYC-YYZ 2025-12-15 max=30000");
    }

    let [, originCity, dest, dateISO, maxStr] = match;
    const maxPoints = maxStr ? Number(maxStr) : Infinity;

    const originAirports = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    const allFlights = [];

    for (const origin of originAirports) {
      try {
        const flights = await searchSmilesAwards(origin, dest, dateISO);
        allFlights.push(...flights);
      } catch (e) {
        console.error(`Failed \( {origin}- \){dest} ${dateISO}:`, e.message);
      }
    }

    const responseText = buildResponse({ flights: allFlights, maxPoints });

    // Proper Twilio WhatsApp XML response
    res.type("text/xml").send(`
<Response>
  <Message>${responseText}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error(err);
    res.type("text/xml").send(`
<Response>
  <Message>Sorry, something went wrong. Try again later.</Message>
</Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smiles WhatsApp Bot running on port ${PORT}`));
