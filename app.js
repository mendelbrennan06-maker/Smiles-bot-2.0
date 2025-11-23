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
