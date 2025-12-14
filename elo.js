// elo.js
// NFL ELO Rating System
// Loads data files, computes historical ELO ratings, and generates predictions

let FINAL_RATINGS = {};
let SCHEDULE = [];
let CONFIG = {};

// ==================== DATA LOADING ====================

async function loadJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function loadCSV(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  const text = await response.text();

  const clean = text.replace(/\uFEFF/g, '').trim();
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = lines.slice(1); // Skip header

  return rows.map(line => {
    const parts = line.split(",").map(p => p.replace(/"/g, "").trim());
    return {
      week: Number(parts[0]),
      winner: parts[1],
      winnerScore: parseScore(parts[2]),
      winnerIsAway: parts[3] === "@",
      loser: parts[4],
      loserScore: parseScore(parts[5])
    };
  });
}

function parseScore(value) {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.-]/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

// ==================== ELO CALCULATIONS ====================

function expectedWinProbability(winnerElo, loserElo, homeFieldAdj) {
  const diff = winnerElo + homeFieldAdj - loserElo;
  return 1 / (1 + Math.pow(10, -diff / 400));
}

function computeKFactor(baseK, marginOfVictory, eloDiff, weekWeight) {
  const movMultiplier = 2.2 / ((eloDiff * 0.001) + 2.2);
  return baseK + marginOfVictory * movMultiplier * weekWeight;
}

function getWinProbability(homeElo, awayElo, homeFieldAdv) {
  return 1 / (1 + Math.pow(10, -(homeElo + homeFieldAdv - awayElo) / 400));
}

// ==================== UI HELPERS ====================

function populateDropdowns(schedule, ratings) {
  const teamSelect = document.getElementById("teamSelect");
  const weekSelect = document.getElementById("weekSelect");
  
  teamSelect.innerHTML = "";
  weekSelect.innerHTML = "";

  // Get all unique teams
  const teamsSet = new Set(Object.keys(ratings));
  schedule.forEach(game => {
    if (game.winner) teamsSet.add(game.winner);
    if (game.loser) teamsSet.add(game.loser);
  });
  const teams = Array.from(teamsSet).sort();
  teams.forEach(team => teamSelect.add(new Option(team, team)));

  // Get only weeks that have future games
  const futureWeeks = Array.from(
    new Set(
      schedule
        .filter(g => !Number.isFinite(g.winnerScore) && !Number.isFinite(g.loserScore))
        .map(g => Number(g.week))
        .filter(w => !Number.isNaN(w))
    )
  ).sort((a, b) => a - b);
  
  futureWeeks.forEach(week => weekSelect.add(new Option(`Week ${week}`, week)));
}

// ==================== TEAM RECORDS TABLE ====================

let CURRENT_SORT = { column: 'elo', ascending: false };

function generateRecordsTable() {
  const tableContainer = document.getElementById("recordsTable");
  if (!tableContainer) return;

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
  
  completedGames.forEach(game => {
    if (records[game.winner]) records[game.winner].wins++;
    if (records[game.loser]) records[game.loser].losses++;
  });

  // Calculate projected wins/losses from future games
  const futureGames = SCHEDULE.filter(g =>
    !Number.isFinite(g.winnerScore) && !Number.isFinite(g.loserScore)
  );

  futureGames.forEach(game => {
    const homeTeam = game.winnerIsAway ? game.loser : game.winner;
    const awayTeam = game.winnerIsAway ? game.winner : game.loser;
    
    if (!records[homeTeam] || !records[awayTeam]) return;
    
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    
    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    
    records[homeTeam].projWins += pHomeWin;
    records[homeTeam].projLosses += (1 - pHomeWin);
    records[awayTeam].projWins += (1 - pHomeWin);
    records[awayTeam].projLosses += pHomeWin;
  });

  // Create team array
  const teamArray = Object.entries(records).map(([team, data]) => ({
    team,
    wins: data.wins,
    losses: data.losses,
    projWins: data.projWins,
    projLosses: data.projLosses,
    totalWins: data.wins + data.projWins,
    elo: data.elo
  }));

  // Sort based on current sort settings
  sortTeamArray(teamArray, CURRENT_SORT.column, CURRENT_SORT.ascending);

  // Build HTML table with sortable headers
  const getSortIndicator = (col) => {
    if (CURRENT_SORT.column === col) {
      return CURRENT_SORT.ascending ? ' ▲' : ' ▼';
    }
    return '';
  };

  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <thead>
        <tr style="background:#f0f0f0; border-bottom:2px solid #ddd;">
          <th onclick="sortTable('team')" style="padding:8px; text-align:left; cursor:pointer; user-select:none;">
            Team${getSortIndicator('team')}
          </th>
          <th onclick="sortTable('wins')" style="padding:8px; text-align:center; cursor:pointer; user-select:none;">
            Current W-L${getSortIndicator('wins')}
          </th>
          <th onclick="sortTable('projWins')" style="padding:8px; text-align:center; cursor:pointer; user-select:none;">
            Proj W-L${getSortIndicator('projWins')}
          </th>
          <th onclick="sortTable('totalWins')" style="padding:8px; text-align:center; cursor:pointer; user-select:none;">
            Total W-L${getSortIndicator('totalWins')}
          </th>
          <th onclick="sortTable('elo')" style="padding:8px; text-align:center; cursor:pointer; user-select:none;">
            ELO${getSortIndicator('elo')}
          </th>
        </tr>
      </thead>
      <tbody>
  `;

  teamArray.forEach((team, index) => {
    const bgColor = index % 2 === 0 ? '#ffffff' : '#f9f9f9';
    const totalLosses = team.losses + team.projLosses;
    html += `
      <tr style="background:${bgColor}; border-bottom:1px solid #eee;">
        <td style="padding:8px;">${team.team}</td>
        <td style="padding:8px; text-align:center;">${team.wins}-${team.losses}</td>
        <td style="padding:8px; text-align:center;">${team.projWins.toFixed(1)}-${team.projLosses.toFixed(1)}</td>
        <td style="padding:8px; text-align:center;"><strong>${team.totalWins.toFixed(1)}-${totalLosses.toFixed(1)}</strong></td>
        <td style="padding:8px; text-align:center;">${team.elo.toFixed(1)}</td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  tableContainer.innerHTML = html;
}

function sortTeamArray(teamArray, column, ascending) {
  teamArray.sort((a, b) => {
    let valA, valB;
    
    switch(column) {
      case 'team':
        valA = a.team.toLowerCase();
        valB = b.team.toLowerCase();
        return ascending 
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      
      case 'wins':
        valA = a.wins;
        valB = b.wins;
        break;
      
      case 'projWins':
        valA = a.projWins;
        valB = b.projWins;
        break;
      
      case 'totalWins':
        valA = a.totalWins;
        valB = b.totalWins;
        break;
      
      case 'elo':
        valA = a.elo;
        valB = b.elo;
        break;
      
      default:
        valA = a.totalWins;
        valB = b.totalWins;
    }
    
    return ascending ? valA - valB : valB - valA;
  });
}

function sortTable(column) {
  // Toggle sort direction if clicking the same column
  if (CURRENT_SORT.column === column) {
    CURRENT_SORT.ascending = !CURRENT_SORT.ascending;
  } else {
    // Default to descending for numeric columns, ascending for team name
    CURRENT_SORT.column = column;
    CURRENT_SORT.ascending = column === 'team';
  }
  
  generateRecordsTable();
}

// Expose sortTable for inline onclick handlers
window.sortTable = sortTable;

// ==================== MAIN ELO CALCULATION ====================

async function runEloCalculation() {
  const statusEl = document.getElementById("status");
  
  if (!statusEl) {
    alert("ERROR: Status element not found in HTML!");
    return;
  }
  
  statusEl.textContent = "Loading data files...";

  try {
    // Load all data files
    const [config, startingElo, schedule] = await Promise.all([
      loadJSON("data/config.json"),
      loadJSON("data/starting_elo.json"),
      loadCSV("data/schedule.csv")
    ]);

    CONFIG = config;
    SCHEDULE = schedule;

    // Extract configuration values
    const K = Number(config.K ?? 50);
    const HFA = Number(config.home_field_advantage ?? 25);
    const halfLife = Number(config.half_life_weeks ?? 12);
    const lambda = Math.log(2) / halfLife;
    const meanElo = Number(config.mean_elo ?? 1500);

    // Initialize ratings
    const ratings = { ...startingElo };
    
    // Filter completed games
    const completedGames = schedule.filter(g => 
      Number.isFinite(g.winnerScore) && Number.isFinite(g.loserScore)
    );
    
    const weeksCompleted = completedGames.length 
      ? Math.max(...completedGames.map(g => g.week)) 
      : 0;

    statusEl.textContent = "Calculating ELO ratings...";

    // Process each completed game
    if (completedGames.length) {
      completedGames.sort((a, b) => a.week - b.week);
      
      for (const game of completedGames) {
        const { week, winner, loser, winnerScore, loserScore, winnerIsAway } = game;
        if (!winner || !loser) continue;

        // Initialize missing teams
        if (ratings[winner] === undefined) ratings[winner] = meanElo;
        if (ratings[loser] === undefined) ratings[loser] = meanElo;

        const winnerElo = Number(ratings[winner]);
        const loserElo = Number(ratings[loser]);

        // Calculate expected probability
        const hfaAdj = winnerIsAway ? -HFA : HFA;
        const expectedProb = expectedWinProbability(winnerElo, loserElo, hfaAdj);

        // Calculate rating changes
        const mov = Math.max(1, winnerScore - loserScore);
        const weekWeight = Math.min(1, Math.exp(-lambda * (weeksCompleted - week)));
        const kPrime = computeKFactor(K, mov, Math.abs(winnerElo - loserElo), weekWeight);
        const delta = kPrime * (1 - expectedProb);

        // Update ratings
        ratings[winner] = winnerElo + delta;
        ratings[loser] = loserElo - delta;
      }
    }

    FINAL_RATINGS = ratings;
    statusEl.textContent = `✓ Processed ${completedGames.length} games through week ${weeksCompleted}`;

    populateDropdowns(SCHEDULE, ratings);
    generateRecordsTable();

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    console.error("ELO Calculation Error:", err);
    alert(`Failed to load data: ${err.message}\n\nCheck browser console for details.`);
  }
}

// ==================== PREDICTIONS ====================

function predictWeek() {
  const week = Number(document.getElementById("weekSelect").value);
  const output = document.getElementById("predictionOutput");
  
  if (!Number.isFinite(week)) {
    output.textContent = "Please select a week.";
    return;
  }

  const futureGames = SCHEDULE.filter(g =>
    Number(g.week) === week &&
    !Number.isFinite(g.winnerScore) &&
    !Number.isFinite(g.loserScore)
  );

  if (!futureGames.length) {
    output.textContent = `No future games found for week ${week}.`;
    return;
  }

  const HFA = Number(CONFIG.home_field_advantage ?? 25);
  const marginFactor = 0.147;

  const predictions = futureGames.map(game => {
    const homeTeam = game.winnerIsAway ? game.loser : game.winner;
    const awayTeam = game.winnerIsAway ? game.winner : game.loser;
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);

    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    const projectedWinner = pHomeWin > 0.5 ? homeTeam : awayTeam;
    const winProb = projectedWinner === homeTeam ? pHomeWin : 1 - pHomeWin;

    const pClamped = Math.min(0.999999999999, Math.max(0.000000000001, winProb));
    const margin = Math.log(pClamped / (1 - pClamped)) / marginFactor;

    return { homeTeam, awayTeam, projectedWinner, winProb, margin };
  });

  predictions.sort((a, b) => b.winProb - a.winProb);

  let result = `Predictions (Week ${week}) — future games only:\n\n`;
  predictions.forEach(p => {
    result += `${p.homeTeam} (Home) vs ${p.awayTeam}\n`;
    result += `  → ${p.projectedWinner} wins | Prob: ${(p.winProb * 100).toFixed(1)}% | Margin: ${p.margin.toFixed(1)} pts\n\n`;
  });
  
  output.textContent = result;
}

function predictTeam() {
  const team = document.getElementById("teamSelect").value;
  const output = document.getElementById("predictionOutput");
  
  if (!team) {
    output.textContent = "Please select a team.";
    return;
  }

  const futureGames = SCHEDULE.filter(g =>
    !Number.isFinite(g.winnerScore) &&
    !Number.isFinite(g.loserScore) &&
    (g.winner === team || g.loser === team)
  );

  if (!futureGames.length) {
    output.textContent = `No future games found for ${team}.`;
    return;
  }

  const HFA = Number(CONFIG.home_field_advantage ?? 25);
  const marginFactor = 0.147;

  const predictions = futureGames.map(game => {
    const homeTeam = game.winnerIsAway ? game.loser : game.winner;
    const awayTeam = game.winnerIsAway ? game.winner : game.loser;
    const homeElo = FINAL_RATINGS[homeTeam] ?? Number(CONFIG.mean_elo ?? 1500);
    const awayElo = FINAL_RATINGS[awayTeam] ?? Number(CONFIG.mean_elo ?? 1500);

    const pHomeWin = getWinProbability(homeElo, awayElo, HFA);
    const projectedWinner = pHomeWin > 0.5 ? homeTeam : awayTeam;
    const winProb = projectedWinner === homeTeam ? pHomeWin : 1 - pHomeWin;
    
    const pClamped = Math.min(0.999999999999, Math.max(0.000000000001, winProb));
    const margin = Math.log(pClamped / (1 - pClamped)) / marginFactor;

    return { homeTeam, awayTeam, projectedWinner, winProb, margin, week: game.week };
  });

  predictions.sort((a, b) => a.week - b.week);

  let result = `Future games for ${team}:\n\n`;
  predictions.forEach(p => {
    result += `Week ${p.week}: ${p.homeTeam} (Home) vs ${p.awayTeam}\n`;
    result += `  → ${p.projectedWinner} wins | Prob: ${(p.winProb * 100).toFixed(1)}% | Margin: ${p.margin.toFixed(1)} pts\n\n`;
  });
  
  output.textContent = result;
}

// ==================== EVENT LISTENERS ====================

window.onload = () => {
  const runBtn = document.getElementById("runBtn");
  const predictWeekBtn = document.getElementById("predictWeekBtn");
  const predictTeamBtn = document.getElementById("predictTeamBtn");
  
  if (runBtn) runBtn.addEventListener("click", runEloCalculation);
  if (predictWeekBtn) predictWeekBtn.addEventListener("click", predictWeek);
  if (predictTeamBtn) predictTeamBtn.addEventListener("click", predictTeam);
};

// Expose for console debugging
window.runEloCalculation = runEloCalculation;

