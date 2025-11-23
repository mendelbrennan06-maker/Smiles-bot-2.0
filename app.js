import express from "express";
import bodyParser from "body-parser";
import puppeteer from "puppeteer";
import twilio from "twilio";

// ======= CONFIGURE YOUR TWILIO WHATSAPP ========
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER; // Example: "whatsapp:+14155238886"
const client = twilio(TWILIO_SID, TWILIO_AUTH);

// ======= EXPRESS SERVER ========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🚀 Smiles WhatsApp Bot is running!");
});

// ======= SCRAPER FUNCTION ========
async function searchFlights(origin, destination) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();
    await page.goto(`https://www.smiles.com.ar/flight-search?origin=${origin}&destination=${destination}`, {
      waitUntil: "networkidle2",
      timeout: 120000
    });

    await page.waitForSelector("app-flight-card", { timeout: 15000 });

    const flights = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("app-flight-card")];
      return cards.slice(0, 10).map(card => {
        return {
          priceMiles: parseInt(card.querySelector(".miles-sales")?.innerText?.replace(/\D/g, "")) || 0,
          originCode: card.querySelector(".origin-airport-code")?.innerText || "",
          destinationCode: card.querySelector(".destination-airport-code")?.innerText || "",
          airline: card.querySelector(".airline-name")?.innerText?.trim() || "",
          date: card.querySelector(".date")?.innerText?.trim() || ""
        };
      });
    });

    return flights;

  } catch (err) {
    console.error("Scraper error:", err);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ======= POINTS TO USD VALUE ========
function pointsToUSD(points) {
  if (points <= 20000) return points * 0.011;
  if (points <= 35000) return points * 0.012;
  if (points <= 70000) return points * 0.013;
  return points * 0.014;
}

// ======= WHATSAPP WEBHOOK ========
app.post("/whatsapp", async (req, res) => {
  const incoming = req.body.Body?.trim()?.toUpperCase() || "";

  // Format example: MIA-BUE max=20000
  const match = incoming.match(/^([A-Z]{3})-([A-Z]{3})(?:\s+MAX=(\d+))?/);

  if (!match) {
    return sendWhatsApp(req.body.From, "❌ Format incorrecto.\nEjemplo:\n*BUE-MIA max=20000*");
  }

  const origin = match[1];
  const destination = match[2];
  const max = match[3] ? parseInt(match[3]) : null;

  const flights = await searchFlights(origin, destination);
  if (!flights.length) {
    return sendWhatsApp(req.body.From, `⚠️ No hay resultados para *${origin}-${destination}*`);
  }

  let formatted = `✈️ *${origin} → ${destination}*\n🔎 Resultados Smiles:\n\n`;

  flights.forEach(f => {
    if (!max || f.priceMiles <= max) {
      const usd = pointsToUSD(f.priceMiles).toFixed(2);
      formatted += `• ${f.originCode} → ${f.destinationCode}\n`;
      formatted += `  🏷 ${f.priceMiles.toLocaleString()} millas\n`;
      formatted += `  💵 ~ $${usd} USD\n`;
      formatted += `  🛫 ${f.airline} | 📅 ${f.date}\n\n`;
    }
  });

  return sendWhatsApp(req.body.From, formatted);
});

// ======= SEND WHATSAPP ========
function sendWhatsApp(to, message) {
  client.messages.create({
    from: TWILIO_NUMBER,
    body: message,
    to: to
  });
}

// ======= START SERVER ========
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
