// elo.js
// Loads data/starting_elo.json, data/config.json, data/schedule.csv
// Runs historical ELO and provides future predictions (week & team).
//

let FINAL_RATINGS = {};
let SCHEDULE = [];
let CONFIG = {};

// ----------------- Loading helpers -----------------
async function loadJSON(path) {
  console.log(`Attempting to load JSON: ${path}`);
  const r = await fetch(path);
  console.log(`Response status for ${path}: ${r.status}`);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  const data = await r.json();
  console.log(`Successfully loaded ${path}`, data);
  return data;
}

async function loadCSV(path) {
  console.log(`Attempting to load CSV: ${path}`);
  const r = await fetch(path);
  console.log(`Response status for ${path}: ${r.status}`);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  const txt = await r.text();

  const clean = txt.replace(/\uFEFF/g, '').trim();
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = lines.slice(1); // skip header

  function toNum(v) {
    if (!v) return null;
    const cleaned = v.replace(/[^\d.-]/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  const result = rows.map(line => {
    const parts = line.split(",").map(p => p.replace(/"/g,"").trim());

    return {
      week: Number(parts[0]),
      winner: parts[1],
      winnerScore: toNum(parts[2]),
      winnerIsAway: parts[3] === "@",
      loser: parts[4],
      loserScore: toNum(parts[5])
    };
  });
  
  console.log(`Successfully loaded ${path}, ${result.length} rows`);
  return result;
}


// ----------------- ELO helper functions -----------------
function expectedProb(winnerElo, loserElo, hfaAdj) {
  const diff = winnerElo + hfaAdj - loserElo;
  return 1 / (1 + Math.pow(10, -diff / 400));
}

function computeKprime(K, mov, eloDiffAbs, wkWeight) {
  const factor = 2.2 / ((eloDiffAbs * 0.001) + 2.2);
  return K + mov * factor * wkWeight; // changed to plus
}

function formatRatings(ratingsObj) {
  return Object.entries(ratingsObj)
    .map(([team, elo]) => ({ team, elo: Number(elo) }))
    .sort((a,b)=>b.elo - a.elo)
    .map(x => `${x.team.padEnd(20)} ${x.elo.toFixed(1)}`)
    .join("\n");
}

function getWinProbability(homeElo, awayElo, HFA) {
  // homeElo and awayElo are raw ELOs (no HFA included)
  return 1 / (1 + Math.pow(10, -(homeElo + HFA - awayElo) / 400));
}

// ----------------- UI population -----------------
function populateDropdowns(schedule, ratings) {
  const teamSelect = document.getElementById("teamSelect");
  const weekSelect = document.getElementById("weekSelect");
  teamSelect.innerHTML = "";
  weekSelect.innerHTML = "";

  // Teams: union of starting ELO keys + all teams in schedule
  const teamsSet = new Set(Object.keys(ratings));
  schedule.forEach(g => { if (g.winner) teamsSet.add(g.winner); if (g.loser) teamsSet.add(g.loser); });
  const teams = Array.from(teamsSet).sort();

  teams.forEach(t => teamSelect.add(new Option(t, t)));

  // Weeks from schedule (unique, sorted)
  const weeks = Array.from(new Set(schedule.map(g => Number(g.week)).filter(w=>!Number.isNaN(w)))).sort((a,b)=>a-b);
  weeks.forEach(w => weekSelect.add(new Option("Week " + w, w)));
}

function sortAndFormat(ratingsObj) {
  const arr = Object.entries(ratingsObj)
    .map(([team, elo]) => ({ team, elo: Number(elo) }))
    .sort((a,b) => b.elo - a.elo);

  return arr.map(x => `${x.team}: ${x.elo.toFixed(2)}`).join("\n");
}

// ----------------- Main: run historical ELO -----------------
async function runEloCalculation(debug = false) {
  console.log("=== runEloCalculation STARTED ===");
  
  const statusEl = document.getElementById("status");
  const outEl = document.getElementById("output");
  
  console.log("Status element:", statusEl);
  console.log("Output element:", outEl);
  
  if (!statusEl) {
    console.error("ERROR: Could not find element with id 'status'");
    alert("ERROR: Could not find status element. Check your HTML!");
    return;
  }
  
  if (!outEl) {
    console.error("ERROR: Could not find element with id 'output'");
    alert("ERROR: Could not find output element. Check your HTML!");
    return;
  }
  
  statusEl.textContent = "Starting ELO calculation...";
  outEl.textContent = "";

  try {    
    statusEl.textContent = "Loading config.json...";
    await new Promise(resolve => setTimeout(resolve, 100)); // Give UI time to update
    const config = await loadJSON("data/config.json");
    
    statusEl.textContent = "Loading starting_elo.json...";
    await new Promise(resolve => setTimeout(resolve, 100));
    const startingElo = await loadJSON("data/starting_elo.json");
    
    statusEl.textContent = "Loading schedule.csv...";
    await new Promise(resolve => setTimeout(resolve, 100));
    const schedule = await loadCSV("data/schedule.csv");
    
    statusEl.textContent = "Processing games...";
    await new Promise(resolve => setTimeout(resolve, 100));

    CONFIG = config;
    SCHEDULE = schedule;

    const K = Number(config.K ?? 50);
    const HFA = Number(config.home_field_advantage ?? 25);
    const halfLife = Number(config.half_life_weeks ?? 12);
    const lambda = Math.log(2) / halfLife;
    const meanElo = Number(config.mean_elo ?? 1500);

    const ratings = Object.assign({}, startingElo || {});
    const completedGames = schedule.filter(g => Number.isFinite(g.winnerScore) && Number.isFinite(g.loserScore));
    const weeksCompleted = completedGames.length ? Math.max(...completedGames.map(g => g.week)) : 0;

    console.log(`Found ${completedGames.length} completed games`);

    if (completedGames.length) {
      completedGames.sort((a,b)=>a.week - b.week);
      for (const g of completedGames) {
        const week = g.week;
        const winner = g.winner;
        const loser = g.loser;
        if (!winner || !loser) continue;

        if (ratings[winner] === undefined) ratings[winner] = meanElo;
        if (ratings[loser] === undefined) ratings[loser] = meanElo;

        const winnerPrior = Number(ratings[winner]);
        const loserPrior = Number(ratings[loser]);

        const hfaAdj = g.winnerIsAway ? -HFA : +HFA;
        const E = expectedProb(winnerPrior, loserPrior, hfaAdj);

        const mov = Math.max(1, g.winnerScore - g.loserScore);
        const wkWeight = Math.min(1, Math.exp(-lambda * (weeksCompleted - week)));
        const kPrime = computeKprime(K, mov, Math.abs(winnerPrior - loserPrior), wkWeight);
        const delta = kPrime * (1 - E);

        const winnerAfter = winnerPrior + delta;
        const loserAfter = loserPrior - delta;

        ratings[winner] = winnerAfter;
        ratings[loser] = loserAfter;
      }
    }

    FINAL_RATINGS = ratings;
    statusEl.textContent = `✓ Processed ${completedGames.length} completed games (weeks 1-${weeksCompleted})`;
    outEl.textContent = sortAndFormat(ratings);

    populateDropdowns(SCHEDULE, ratings);
    generateRecordsTable(); // Generate the records table
    
    console.log("=== runEloCalculation COMPLETED SUCCESSFULLY ===");

  } catch (err) {
    const errorMsg = `Error: ${err.message}`;
    console.error("=== ERROR IN runEloCalculation ===");
    console.error(err);
    statusEl.textContent = errorMsg;
    outEl.textContent = `Failed to load data. Check console for details.\n\nError: ${err.message}`;
    alert(`Error loading data: ${err.message}\n\nCheck the browser console (F12) for more details.`);
  }
}

// expose function to console if needed
window.runEloCalculation = runEloCalculation;


// ----------------- Team Records Table -----------------
function generateRecordsTable() {
  const tableContainer = document.getElementById("recordsTable");
  if (!tableContainer) {
    console.error("Could not find recordsTable element");
    return;
  }

  if (!SCHEDULE.length || !Object.keys(FINAL_RATINGS).length) {
    tableContainer.innerHTML = "<p>Run ELO calculation first to see team records.</p>";
    return;
  }

  const HFA = Number(CONFIG.home_field_advantage ?? 25);
  
  // Initialize records for all teams
  const records = {};
  Object.keys(FINAL_RATINGS).forEach(team => {
    records[team] = { 
      wins: 0, 
      losses: 0, 
      projWins: 0, 
      projLosses: 0,
      elo: FINAL_RATINGS[team]
    };
  });

  // Count actual wins/losses from completed games
  const completedGames = SCHEDULE.filter(g => 
    Number.isFinite(g.winnerScore) && Number.isFinite(g.loserScore)
  );
  
  completedGames.forEach(g => {
    if (records[g.winner]) records[g.winner].wins++;
    if (records[g.loser]) records[g.loser].losses++;
  });

  // Calculate projected wins/losses from future games
  const futureGames = SCHEDULE.filter(g =>
    !Number.isFinite(g.winnerScore) && !Number.isFinite(g.loserScore)
  );

  futureGames.forEach(g => {
    const homeTeam = g.winnerIsAway ? g.loser : g.winner;
    const awayTeam = g.winnerIsAway ? g.winner : g.loser;
    
    if (!records[homeTeam] || !records[awayTeam]) return;
    
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    
    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    
    // Add fractional wins/losses based on probability
    records[homeTeam].projWins += pHomeWin;
    records[homeTeam].projLosses += (1 - pHomeWin);
    records[awayTeam].projWins += (1 - pHomeWin);
    records[awayTeam].projLosses += pHomeWin;
  });

  // Convert to array and sort by total projected wins (current + projected)
  const teamArray = Object.entries(records).map(([team, data]) => ({
    team,
    wins: data.wins,
    losses: data.losses,
    projWins: data.projWins,
    projLosses: data.projLosses,
    totalWins: data.wins + data.projWins,
    elo: data.elo
  })).sort((a, b) => b.totalWins - a.totalWins);

  // Build HTML table
  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <thead>
        <tr style="background:#f0f0f0; border-bottom:2px solid #ddd;">
          <th style="padding:8px; text-align:left;">Team</th>
          <th style="padding:8px; text-align:center;">Current W-L</th>
          <th style="padding:8px; text-align:center;">Proj W-L</th>
          <th style="padding:8px; text-align:center;">Total W-L</th>
          <th style="padding:8px; text-align:center;">ELO</th>
        </tr>
      </thead>
      <tbody>
  `;

  teamArray.forEach((team, index) => {
    const bgColor = index % 2 === 0 ? '#ffffff' : '#f9f9f9';
    html += `
      <tr style="background:${bgColor}; border-bottom:1px solid #eee;">
        <td style="padding:8px;">${team.team}</td>
        <td style="padding:8px; text-align:center;">${team.wins}-${team.losses}</td>
        <td style="padding:8px; text-align:center;">${team.projWins.toFixed(1)}-${team.projLosses.toFixed(1)}</td>
        <td style="padding:8px; text-align:center;"><strong>${team.totalWins.toFixed(1)}-${(team.losses + team.projLosses).toFixed(1)}</strong></td>
        <td style="padding:8px; text-align:center;">${team.elo.toFixed(1)}</td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  tableContainer.innerHTML = html;
}

// ----------------- Predictions (future only) -----------------
function predictWeek() {
  const week = Number(document.getElementById("weekSelect").value);
  if (!Number.isFinite(week)) {
    document.getElementById("predictionOutput").textContent = "Please select a week.";
    return;
  }

  const futureGames = SCHEDULE.filter(g =>
    Number(g.week) === week &&
    !Number.isFinite(g.winnerScore) &&
    !Number.isFinite(g.loserScore)
  );

  if (!futureGames.length) {
    document.getElementById("predictionOutput").textContent = `No future games found for week ${week}.`;
    return;
  }

  const HFA = Number(CONFIG.home_field_advantage ?? 25);
  const k = 0.147;

  const predictions = futureGames.map(g => {
    const homeTeam = g.winnerIsAway ? g.loser : g.winner;
    const awayTeam = g.winnerIsAway ? g.winner : g.loser;
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);

    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    const projectedWinner = pHomeWin > 0.5 ? homeTeam : awayTeam;
    const pWinner = projectedWinner === homeTeam ? pHomeWin : 1 - pHomeWin;

    const eps = 1e-12;
    const pClamped = Math.min(1 - eps, Math.max(eps, pWinner));
    const margin = Math.log(pClamped / (1 - pClamped)) / k;

    return { homeTeam, awayTeam, projectedWinner, winProb: pWinner, margin };
  });

  predictions.sort((a,b)=>b.winProb - a.winProb);

  let out = `Predictions (Week ${week}) — future games only:\n`;
  for (const p of predictions) {
    out += `${p.homeTeam} (Home) vs ${p.awayTeam} → ${p.projectedWinner} wins, Prob: ${(p.winProb*100).toFixed(1)}%, Margin: ${p.margin.toFixed(1)} pts\n`;
  }
  document.getElementById("predictionOutput").textContent = out;
}

function predictTeam() {
  const team = document.getElementById("teamSelect").value;
  if (!team) {
    document.getElementById("predictionOutput").textContent = "Please select a team.";
    return;
  }

  const futureGames = SCHEDULE.filter(g =>
    !Number.isFinite(g.winnerScore) &&
    !Number.isFinite(g.loserScore) &&
    (g.winner === team || g.loser === team)
  );

  if (!futureGames.length) {
    document.getElementById("predictionOutput").textContent = `No future games found for ${team}.`;
    return;
  }

  const HFA = Number(CONFIG.home_field_advantage ?? 25);
  const k = 0.147;

  const predictions = futureGames.map(g => {
    const homeTeam = g.winnerIsAway ? g.loser : g.winner;
    const awayTeam = g.winnerIsAway ? g.winner : g.loser;
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);

    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    const projectedWinner = pHomeWin > 0.5 ? homeTeam : awayTeam;
    const pWinner = projectedWinner === homeTeam ? pHomeWin : 1 - pHomeWin;
    const eps = 1e-12;
    const pClamped = Math.min(1 - eps, Math.max(eps, pWinner));
    const margin = Math.log(pClamped / (1 - pClamped)) / k;

    return { homeTeam, awayTeam, projectedWinner, winProb: pWinner, margin };
  });

  predictions.sort((a,b)=>b.winProb - a.winProb);

  let out = `Future games for ${team}:\n`;
  for (const p of predictions) {
    out += `${p.homeTeam} (Home) vs ${p.awayTeam} → ${p.projectedWinner} wins, Prob: ${(p.winProb*100).toFixed(1)}%, Margin: ${p.margin.toFixed(1)} pts\n`;
  }
  document.getElementById("predictionOutput").textContent = out;
}

// ----------------- Wiring -----------------
window.onload = () => {
  console.log("=== Page loaded, setting up event listeners ===");
  
  const runBtn = document.getElementById("runBtn");
  const predictWeekBtn = document.getElementById("predictWeekBtn");
  const predictTeamBtn = document.getElementById("predictTeamBtn");
  
  console.log("runBtn:", runBtn);
  console.log("predictWeekBtn:", predictWeekBtn);
  console.log("predictTeamBtn:", predictTeamBtn);
  
  if (!runBtn) {
    console.error("ERROR: Could not find button with id 'runBtn'");
  } else {
    runBtn.addEventListener("click", () => {
      console.log("Run button clicked!");
      runEloCalculation();
    });
  }
  
  if (predictWeekBtn) {
    predictWeekBtn.addEventListener("click", predictWeek);
  }
  
  if (predictTeamBtn) {
    predictTeamBtn.addEventListener("click", predictTeam);
  }
  
  console.log("=== Event listeners set up complete ===");
};
