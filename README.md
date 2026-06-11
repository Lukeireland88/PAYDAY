# Payday Bank

A single-file digital banker companion for the **Modern Payday** board game. Track cash, loans, bills, jackpots, and lotteries while you play — no paper ledger required.

Open `index.html` in any modern browser. No build step or dependencies required.

For **install as an app** (Add to Home Screen / Install app), serve the folder over HTTP — for example `npx serve .` — then use your browser’s install or share menu.

## Quick Start

1. Open `index.html` in Chrome, Firefox, Safari, or Edge (or serve the folder locally for full web app install support).
2. Set up **2–6 players**, names, salaries, and starting cash (default **$3,500** each).
3. Click **Start Game**.
4. Use player cards and the jackpot bar during play. Progress saves automatically to your browser.

To resume later, open the same file in the same browser — your game is stored in `localStorage` under the key `payday-bank-v2`.

## Features

### Game tab
- **Summary bar** — loans, jackpot, unpaid bills, leader, and most debt (ties shown correctly). Toggle from the header — hidden by default on phones.
- **Jackpot panel** — pool total and quick actions; toggle from the header (hidden by default on phones).
- **Player board (Focus mode)** — tap a player in the roster, then use actions for that player only (reduces mis-taps on shared devices). Switch to **Classic layout** from the header for all cards with actions visible at once.
- **Jackpot bar** — current pool plus quick actions for contributions, lottery, and jackpot wins.

### Per-player actions
| Action | Purpose |
|--------|---------|
| **Receive** | Bank pays the player (salary, mail, deals, etc.) |
| **Pay** | Player pays the bank |
| **Transfer** | Player-to-player payment |
| **Loan** | Take a loan ($1,000 minimum, $1,000 increments) |
| **Add Bill** | Record an outstanding bill |
| **View Bills** | Review or remove bills before payday |
| **Jackpot** | Player contributes to the jackpot pool |
| **Edit** | Manual correction (name, cash, loan, salary) |
| **PAYDAY** | Process end-of-month finances |

### Payday (official order)
Payday runs in this sequence:

1. **Salary** added  
2. **Loan interest** deducted (10%)  
3. **Loan repayment** (optional, Pay Day only, $1,000 increments)  
4. **All bills** paid (required — no skipping)

If cash is short after the above, **auto-loan** can round up the shortfall to the nearest $1,000 increment.

### Jackpot
- Players add money to the pool when board spaces or mail cards require it.
- **Rolled a 6!** awards the full jackpot to the player who rolled a 6 on their regular turn.
- **Edit Jackpot** lets the banker correct the pool amount if needed.

The bank does not contribute to the jackpot.

### Lottery
- Bank antes **$1,000**.
- Each player may optionally ante **$100** (check who entered).
- Play out the lottery with the **physical game die**, then select the winner in the app.
- Prize = $1,000 + ($100 × number of entrants).

### Banker tab
Quick actions for common banker tasks:
- Bank pay player / player pay bank
- Rolled a 6! (jackpot)
- Run lottery

Includes a table of all player balances, loans, bills, net worth, and paydays.

### History, stats & leaderboard
- **History** — searchable, filterable transaction log with undo (single or multiple).
- **Stats** — per-player totals for received, paid, loans, jackpots, and more.
- **Leaderboard** — ranked by net worth (cash − loan − bills), with tie handling.
- **End Game — Show Winner** — celebration screen with confetti.

### Export & backup
From the History tab:
- Export transactions or balances as **CSV**
- **Backup JSON** (full game state)
- **Print Summary**

From setup, **Import Saved Game (JSON)** restores a backup.

## Modern Payday rules implemented

| Rule | Behavior |
|------|----------|
| Starting cash | Default $3,500 per player |
| Loan interest | 10% on Pay Day |
| Loan increments | $1,000 minimum; repayments in $1,000 steps |
| Loan repayment | Only on Pay Day (via PAYDAY button) |
| Bills | All outstanding bills paid on Pay Day |
| Jackpot | Player contributions; win by rolling a 6 |
| Lottery | Bank $1,000 + optional $100 player antes |

Optional setup checkbox: **Enforce official repayment increments** (validates loan balances stay on $1,000 steps).

## Settings & UI

- **Theme** — light / dark toggle
- **Sound** — optional transaction sounds (off by default)
- **Stay Awake** — keeps the screen on while the app is open (on by default; requires a supported browser)
- **Summary / Jackpot / Layout** — game panel toggles in the expanded header (visible during play)
- **Focus / Classic layout** — Focus mode (default) shows a read-only roster plus one action panel; Classic shows every player card with buttons
- **New Game** — wipe progress and return to setup
- **Reset Game** — reset balances and jackpot, keep player names
- **Clear Saved Data** — remove all `localStorage` data

## Install as a web app

Payday Bank includes a web app manifest and service worker so it can be installed like a native app.

1. Serve the project folder locally, e.g. `npx serve .`
2. Open the URL in your browser.
3. Install:
   - **Chrome / Edge (Android or desktop):** Install icon in the address bar, or browser menu → *Install Payday Bank*
   - **Safari (iOS):** Share → *Add to Home Screen*

Installed mode runs fullscreen without browser chrome. Game data still saves locally in the browser.

> Opening `index.html` directly from disk (`file://`) works for play, but install prompts require serving over `http://localhost` or HTTPS.

## Technical notes

- **Single file:** all HTML, CSS, and JavaScript live in `index.html`.
- **Web app files:** `manifest.webmanifest`, `sw.js`, and `icons/` enable install and offline caching.
- **Persistence:** browser `localStorage` only; data stays on the device. Clearing site data or using a different browser starts fresh.
- **Privacy:** nothing is sent to a server.
- **Undo:** reverses the last transaction(s) by restoring snapshotted balances.

## Tips

- Use **notes** on transactions (preset chips like Mail, Deal Card, Jackpot) to make history easier to search.
- Run the app on a tablet or laptop beside the board so one person can act as banker.
- Back up long games occasionally with **Backup JSON** from the History tab.

## License

Personal / family use companion app for the Payday board game. Payday is a trademark of its respective owners; this project is not affiliated with or endorsed by the game publisher.
