// app.js - Smiles WhatsApp Bot with Puppeteer (Works Nov 2025)
import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const BRL_TO_USD_RATE = 5.8;

function brlToUsd(brl) {
  return Number((brl / BRL_TO_USD_RATE).toFixed(0));
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

// Scrape Smiles with Puppeteer (beats bot protection)
async function scrapeSmiles(origin, dest, dateISO) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-web-security"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

  try {
    // Go to search page
    await page.goto("https://www.smiles.com.br/busca-passagens", { waitUntil: "networkidle2", timeout: 30000 });

    // Fill form (selectors from current DOM - Nov 2025)
    await page.waitForSelector("[data-testid='origin-input']", { timeout: 10000 });
    await page.fill("[data-testid='origin-input']", origin);
    await page.click("[data-testid='origin-suggestion']"); // Select first suggestion

    await page.fill("[data-testid='destination-input']", dest);
    await page.click("[data-testid='destination-suggestion']");

    await page.fill("[data-testid='departure-date']", dateISO);
    await page.click("[data-testid='search-button']");

    // Wait for results
    await page.waitForSelector(".flight-card", { timeout: 30000 });

    // Extract flights
    const flights = await page.evaluate(() => {
      const rows = document.querySelectorAll(".flight-card");
      return Array.from(rows).map(row => {
        const airline = row.querySelector(".airline-name")?.innerText?.trim() || "GOL";
        const originCode = row.querySelector(".origin-code")?.innerText?.trim() || null;
        const destCode = row.querySelector(".dest-code")?.innerText?.trim() || null;
        const dep = row.querySelector(".depart-time")?.innerText?.trim() || "";
        const arr = row.querySelector(".arrival-time")?.innerText?.trim() || "";
        
        // Points and taxes from award sections
        const econPts = row.querySelector("[data-testid='economy-points']")?.innerText?.match(/(\d+)/)?.[1] || null;
        const busPts = row.querySelector("[data-testid='business-points']")?.innerText?.match(/(\d+)/)?.[1] || null;
        const taxesText = row.querySelector(".taxes-amount")?.innerText?.trim() || "";
        const taxesBRL = taxesText.match(/R\$\s*([\d.,]+)/)?.[1]?.replace(/\./g, '').replace(',', '.') || 0;

        return { airline, originCode, destCode, dep, arr, econPts: parseInt(econPts) || null, busPts: parseInt(busPts) || null, taxesBRL: parseFloat(taxesBRL) };
      }).filter(f => f.econPts || f.busPts);
    });

    return flights;
  } catch (e) {
    console.error("Scrape error:", e.message);
    return [];
  } finally {
    await browser.close();
  }
}

function buildResponse({ flights, maxPoints = Infinity }) {
  const valid = flights.filter(f => Math.min(f.econPts || Infinity, f.busPts || Infinity) <= maxPoints);
  if (!valid.length) return "No award space found under your max points.";

  const both = valid.filter(f => f.econPts && f.busPts);
  const econOnly = valid.filter(f => f.econPts && !f.busPts);
  const busOnly = valid.filter(f => !f.econPts && f.busPts);

  function sortByDep(arr) {
    return arr.sort((a, b) => a.dep.localeCompare(b.dep));
  }

  const sections = [
    { title: "Both Economy & Business", items: sortByDep(both) },
    { title: "Economy only", items: sortByDep(econOnly) },
    { title: "Business only", items: sortByDep(busOnly) },
  ];

  let out = "";
  sections.forEach(sec => {
    if (!sec.items.length) return;
    out += `=== ${sec.title} ===\n`;

    const byOriginAirline = {};
    sec.items.forEach(f => {
      const key = `\( {f.originCode || "ORIG"}- \){f.airline || "AIRLINE"}`;
      byOriginAirline[key] = byOriginAirline[key] || [];
      byOriginAirline[key].push(f);
    });

    Object.entries(byOriginAirline).forEach(([key, list]) => {
      const [origin, airline] = key.split("-");
      out += `\n\( {airline} from \){origin}:\n`;
      list.forEach(f => {
        const dep12 = to12Hour(f.dep);
        const arr12 = to12Hour(f.arr);
        const econ = f.econPts ? `${f.econPts}` : "-";
        const bus = f.busPts ? `${f.busPts}` : "-";
        const taxesUSD = f.taxesBRL ? brlToUsd(f.taxesBRL) : "-";
        const lowestPts = econ !== "-" ? econ : bus;

        out += `\( {origin} \){dep12} - \( {f.destCode} \){arr12}\n`;
        out += `  Economy pts: \( {econ} | Business pts: \){bus}\n`;
        out += `  1=${lowestPts} (points)  2=\[ {taxesUSD} (USD taxes)\n`;
        if (f.econPts) out += `    (points value est: \]{ptsValueUsd(f.econPts).toFixed(2)})\n`;
        if (f.busPts) out += `    (points value est: $${ptsValueUsd(f.busPts).toFixed(2)})\n`;
      });
    });
    out += "\n";
  });

  return out;
}

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim().toUpperCase();
    const match = incoming.match(/([A-Z]{3})-([A-Z]{3})\s+([\d-]{10})(?:\s+MAX=(\d+))?/i);
    if (!match) {
      return res.type("text/xml").send("<Response><Message>Format: NYC-GRU 2025-12-20 max=50000</Message></Response>");
    }

    const [, originCity, dest, dateISO, maxStr] = match;
    const maxPoints = maxStr ? Number(maxStr) : Infinity;
    const originAirports = originCity === "NYC" ? ["JFK", "LGA", "EWR"] : [originCity];

    let allFlights = [];
    for (const o of originAirports) {
      const flights = await scrapeSmiles(o, dest, dateISO);
      allFlights.push(...flights);
    }

    const responseText = buildResponse({ flights: allFlights, maxPoints });

    res.type("text/xml").send(`
<Response>
  <Message>${responseText}</Message>
</Response>
    `.trim());
  } catch (err) {
    console.error(err);
    res.type("text/xml").send("<Response><Message>Sorry, something went wrong. Try again later.</Message></Response>");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Smiles WhatsApp Bot running on", PORT));
