// elo.js
// Loads data/starting_elo.json, data/config.json, data/schedule.csv
// Runs historical ELO and provides future predictions (week & team).
//

let FINAL_RATINGS = {};
let SCHEDULE = [];
let CONFIG = {};

// ----------------- Loading helpers -----------------
async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

async function loadCSV(path) {
  const r = await fetch(path);
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

  return rows.map(line => {
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

// ----------------- Main: run historical ELO -----------------
async function runEloCalculation(debug = false) {
  const statusEl = document.getElementById("status");
  const outEl = document.getElementById("eloOutput");
  statusEl.textContent = "Loading input files...";
  outEl.textContent = "";

  try {
    const [startingElo, config, schedule] = await Promise.all([
      loadJSON("data/starting_elo.json"),
      loadJSON("data/config.json"),
      loadCSV("data/schedule.csv")
    ]);

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

    // prepare debug array if needed
    const trace = []; // each element: object with detailed fields

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

        // historical MOV
        const mov = Math.max(1, g.winnerScore - g.loserScore);
        const wkWeight = Math.min(1, Math.exp(-lambda * (weeksCompleted - week)));
        const kPrime = computeKprime(K, mov, Math.abs(winnerPrior - loserPrior), wkWeight);
        const delta = kPrime * (1 - E);

        const winnerAfter = winnerPrior + delta;
        const loserAfter = loserPrior - delta;

        // Apply updates
        ratings[winner] = winnerAfter;
        ratings[loser] = loserAfter;

        // push trace row
        trace.push({
          week,
          winner,
          loser,
          winnerScore: g.winnerScore,
          loserScore: g.loserScore,
          winnerPrior: Number(winnerPrior.toFixed(6)),
          loserPrior: Number(loserPrior.toFixed(6)),
          hfaAdj: Number(hfaAdj.toFixed(6)),
          E: Number(E.toFixed(8)),
          mov,
          wkWeight: Number(wkWeight.toFixed(8)),
          kPrime: Number(kPrime.toFixed(8)),
          delta: Number(delta.toFixed(8)),
          winnerAfter: Number(winnerAfter.toFixed(6)),
          loserAfter: Number(loserAfter.toFixed(6))
        });
      }
    }

    FINAL_RATINGS = ratings;
    statusEl.textContent = `Processed ${completedGames.length} completed games (weeksCompleted=${weeksCompleted}).`;
    outEl.textContent = sortAndFormat(ratings);

    populateDropdowns(SCHEDULE, ratings);

    // If debug requested, present trace
    if (false && debug) {
      console.log("ELO per-game trace:", trace);
      // show first 100 rows in console table (or all if small)
      console.table(trace.slice(0, 500));

      // also create CSV for download and small HTML table below output
      const csvHeader = [
        "week","winner","loser","winnerScore","loserScore",
        "winnerPrior","loserPrior","hfaAdj","E","mov","wkWeight","kPrime","delta","winnerAfter","loserAfter"
      ].join(",");

      const csvRows = trace.map(r => csvHeader.split(",").map(h => {
        const v = r[h];
        // escape commas and quotes
        if (v === null || v === undefined) return "";
        return String(v).includes(",") ? `"${String(v).replace(/"/g,'""')}"` : String(v);
      }).join(","));

      const csvContent = [csvHeader].concat(csvRows).join("\n");
      // create a blob and link
      const blob = new Blob([csvContent], {type: "text/csv;charset=utf-8;"});
      const url = URL.createObjectURL(blob);

      // show link in statusEl
      const linkId = "eloTraceDownload";
      let link = document.getElementById(linkId);
      if (!link) {
        link = document.createElement("a");
        link.id = linkId;
        link.textContent = "Download ELO trace CSV";
        link.style.display = "inline-block";
        link.style.marginLeft = "12px";
        statusEl.appendChild(link);
      }
      link.href = url;
      link.download = `elo_trace_week${weeksCompleted || 0}.csv`;

      // also inject a short HTML table under the output for quick glance
      const debugElId = "debugTraceTable";
      let debugEl = document.getElementById(debugElId);
      if (!debugEl) {
        debugEl = document.createElement("div");
        debugEl.id = debugElId;
        debugEl.style.marginTop = "12px";
        document.getElementById("output").insertAdjacentElement("afterend", debugEl);
      }
      // build small table(html) for first up to 50 rows
      const rowsToShow = trace.slice(0, 50);
      let html = `<div style="max-height:300px; overflow:auto; border:1px solid #ddd; padding:6px;"><table style="width:100%; border-collapse:collapse; font-size:12px;">`;
      html += `<thead><tr style="background:#f0f0f0"><th>wk</th><th>winner</th><th>loser</th><th>wPrior</th><th>lPrior</th><th>E</th><th>MOV</th><th>K'</th><th>Δ</th><th>wAfter</th><th>lAfter</th></tr></thead><tbody>`;
      for (const r of rowsToShow) {
        html += `<tr>
          <td>${r.week}</td>
          <td>${r.winner}</td>
          <td>${r.loser}</td>
          <td style="text-align:right">${r.winnerPrior}</td>
          <td style="text-align:right">${r.loserPrior}</td>
          <td style="text-align:right">${r.E}</td>
          <td style="text-align:right">${r.mov}</td>
          <td style="text-align:right">${r.kPrime}</td>
          <td style="text-align:right">${r.delta}</td>
          <td style="text-align:right">${r.winnerAfter}</td>
          <td style="text-align:right">${r.loserAfter}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
      debugEl.innerHTML = html;
    }

  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    console.error(err);
    document.getElementById("output").textContent = "Error -- see console.";
  }

  function sortAndFormat(ratingsObj) {
  const arr = Object.entries(ratingsObj)
    .map(([team, elo]) => ({ team, elo: Number(elo) }))
    .sort((a,b) => b.elo - a.elo);

  return arr.map(x => `${x.team}: ${x.elo.toFixed(2)}`).join("\n");
}
}

// expose function to console if needed
window.runEloCalculation = runEloCalculation;


// ----------------- Predictions (future only) -----------------
function predictWeek() {
  const week = Number(document.getElementById("weekSelect").value);
  if (!Number.isFinite(week)) {
    document.getElementById("predictionOutput").textContent = "Please select a week.";
    return;
  }

  // future games: scores are NOT finite numbers (null or non-numeric)
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

    // safeguard pWinner in (eps, 1-eps)
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
  document.getElementById("runBtn").addEventListener("click", runEloCalculation);
  document.getElementById("predictWeekBtn").addEventListener("click", predictWeek);
  document.getElementById("predictTeamBtn").addEventListener("click", predictTeam);
};

