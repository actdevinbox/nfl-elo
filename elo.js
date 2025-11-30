// elo.js - loads data/starting_elo.json, data/config.json, data/schedule.csv
// and computes ELO using the provided formulas.

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

async function loadCSV(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  const txt = await r.text();
  const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return []; // no data rows
  const rows = lines.slice(1).map(line => {
    // split into up to 6 columns; allow commas in team names? assume not.
    const parts = line.split(",").map(s => s.trim());
    // Expected: Week,Winner,WinnerScore,H/A,Loser,LoserScore
    const [weekStr, winner, winnerScoreStr, ha, loser, loserScoreStr] = parts;
    return {
      week: Number(weekStr),
      winner,
      winnerScore: winnerScoreStr === "" ? null : Number(winnerScoreStr),
      winnerIsAway: ha === "@",
      loser,
      loserScore: loserScoreStr === "" ? null : Number(loserScoreStr)
    };
  });
  return rows;
}

function expectedProb(winnerEloPrior, loserEloPrior, hfaAdj) {
  // E = 1/(1 + 10^(-(winner_elo_prior + HFA_adj - loser_elo_prior) / 400))
  const diff = (winnerEloPrior + hfaAdj) - loserEloPrior;
  const exponent = -diff / 400;
  return 1 / (1 + Math.pow(10, exponent));
}

function computeKprime(K, mov, eloDiffAbs, wkWeight) {
  // K' = K * ln(MOV + 1) * 2.2 / ((abs(diff) * .001) + 2.2) * wk_weight
  // mov assumed >= 1
  const movTerm = Math.log(mov + 1); // ln(MOV + 1)
  const denom = (eloDiffAbs * 0.001) + 2.2;
  const factor = (2.2 / denom);
  return K * movTerm * factor * wkWeight;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function runEloCalculation() {
  const statusEl = document.getElementById("status");
  const outEl = document.getElementById("output");
  statusEl.textContent = "Loading input files...";
  outEl.textContent = "";

  try {
    const [startingElo, config, schedule] = await Promise.all([
      loadJSON("data/starting_elo.json"),
      loadJSON("data/config.json"),
      loadCSV("data/schedule.csv")
    ]);

    // Parameters
    const K = Number(config.K ?? 50);
    const HFA = Number(config.home_field_advantage ?? 25);
    const halfLife = Number(config.half_life_weeks ?? 12);
    const meanElo = Number(config.mean_elo ?? 1500);
    const lambda = Math.log(2) / halfLife;

    // Prepare ratings object (copy so we don't mutate original file)
    const ratings = Object.assign({}, startingElo);

    // Determine weeksCompleted (max week among games that have scores)
    const completedGames = schedule.filter(g => g.winnerScore !== null && g.loserScore !== null);
    const weeksCompleted = completedGames.length ? Math.max(...completedGames.map(g => g.week)) : 0;

    // If no completed games -> nothing to update
    if (completedGames.length === 0) {
      statusEl.textContent = "No completed games found in schedule.csv (no scores provided).";
      // still display starting ratings (sorted)
      const sortedEmpty = sortAndFormat(ratings, meanElo);
      outEl.textContent = sortedEmpty;
      return;
    }

    // Sort completed games by week ascending to process chronologically
    completedGames.sort((a,b) => a.week - b.week);

    // Process each completed game
    for (const g of completedGames) {
      const week = g.week;
      const winner = g.winner;
      const loser = g.loser;
      const winnerScore = g.winnerScore;
      const loserScore = g.loserScore;

      // ensure teams exist in ratings
      if (ratings[winner] === undefined) ratings[winner] = meanElo;
      if (ratings[loser] === undefined) ratings[loser] = meanElo;

      const winnerPrior = Number(ratings[winner]);
      const loserPrior = Number(ratings[loser]);

      // HFA_adj: apply HFA to the team that is home.
      // H/A refers to the winner: empty/null => winner was home, '@' => winner was away
      // If winner was home => HFA_adj = +HFA. If winner was away => HFA_adj = 0 (since home advantage applies to the home team which is the loser in that case, but our formula puts HFA_adj on the winner; user confirmed interpretation earlier)
      // User said earlier: "If winner is home → HFA_adj = +HFA; If winner is away → HFA_adj = -HFA"
      // We'll follow the user's confirmed rule: winner gets +HFA if home, -HFA if away.
      const hfaAdj = g.winnerIsAway ? -HFA : +HFA;

      // Expected win prob (E)
      const E = expectedProb(winnerPrior, loserPrior, hfaAdj);

      // MOV: ensure at least 1
      const rawMov = Math.max(1, winnerScore - loserScore);
      const mov = rawMov;

      // week weight: wk_weight = min(1, e^(-lambda * (weeksCompleted - week)))
      const wkWeight = Math.min(1, Math.exp(-lambda * (weeksCompleted - week)));

      // K'
      const kPrime = computeKprime(K, mov, Math.abs(winnerPrior - loserPrior), wkWeight);

      // rating change
      const delta = kPrime * (1 - E);

      // Apply updates: winner +delta, loser -delta
      ratings[winner] = winnerPrior + delta;
      ratings[loser] = loserPrior - delta;
    }

    statusEl.textContent = `Processed ${completedGames.length} completed games (weeksCompleted = ${weeksCompleted}).`;
    outEl.textContent = sortAndFormat(ratings, meanElo);

  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    console.error(err);
    document.getElementById("output").textContent = "Error -- see console.";
  }
}

function sortAndFormat(ratingsObj, meanElo) {
  // In case some teams never appeared and you want them included, add nothing more.
  const arr = Object.entries(ratingsObj)
    .map(([team, elo]) => ({ team, elo: Number(elo) }))
    .sort((a,b) => b.elo - a.elo);

  return arr.map(x => `${x.team}: ${x.elo.toFixed(1)}`).join("\n");
}

// Wire button
document.getElementById("runBtn").addEventListener("click", runEloCalculation);
