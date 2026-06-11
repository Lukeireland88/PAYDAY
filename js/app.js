/* PAYDAY BANK - Multiplayer Application Logic */
(function () {
  'use strict';

  const MP = () => window.PaydayMultiplayer;
  const GE = () => window.GameEngine;
  const THEME_KEY = 'payday-theme';
  const LOTTERY_BANK_AMOUNT = 1000;
  const LOTTERY_PLAYER_AMOUNT = 100;
  const NOTE_PRESETS = ['Salary','Bill','Mail','Deal Card','Lottery','Yard Sale','Insurance','Radio Contest','Stock Purchase','Jackpot','Other'];
  const TXN_LABELS = {
    bank_payment:'Bank Payment', bank_deposit:'Bank Deposit', player_transfer:'Player Transfer',
    loan_taken:'Loan Taken', loan_repaid:'Loan Repaid', loan_interest:'Loan Interest',
    savings_deposit:'Savings Deposit', savings_withdrawal:'Savings Withdrawal', savings_interest:'Savings Interest',
    payday_salary:'Payday Salary', bill_added:'Bill Added', bill_paid:'Bill Paid',
    jackpot_contribution:'Jackpot Contribution', jackpot_payout:'Jackpot Payout', jackpot_six:'Jackpot (Rolled 6)',
    lottery_draw:'Lottery Draw', manual_adjustment:'Manual Adjustment'
  };

  let state = defaultState();
  let activeModal = null;
  let soundsOn = false;
  let saveFlashTimer = null;

  function defaultState() { return GE().defaultState(); }

  function uid() { return GE().uid(); }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function money(n) {
    n = Number(n) || 0;
    return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  }

  function parseAmt(v) {
    const n = parseFloat(v);
    return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function editionRules() { return GE().editionRules(); }

  function getPlayer(id) { return state.players.find(p => p.id === id); }
  function playerName(id) {
    if (id === 'bank') return 'Bank';
    if (id === 'jackpot') return 'Jackpot';
    const p = getPlayer(id);
    return p ? p.name : '?';
  }

  function billsTotal(p) { return GE().billsTotal(p); }
  function netWorth(p) { return GE().netWorth(p); }

  function syncFromServer() {
    const s = MP().getState();
    if (s) state = s;
  }

  function flashSync() {
    const el = $('#save-status');
    el.textContent = 'Synced';
    el.classList.add('saved');
    clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => updateRoomStatus(), 1500);
  }

  function updateRoomStatus() {
    const el = $('#save-status');
    const code = MP().getRoomCode();
    const role = MP().session?.role;
    el.textContent = code ? `Room ${code}${role === 'banker' ? ' · Banker' : ''}` : 'Ready';
    el.classList.remove('saved');
  }

  function saveTheme() {
    try { localStorage.setItem(THEME_KEY, state.theme || 'light'); } catch (_) {}
  }

  function loadTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t) state.theme = t;
    } catch (_) {}
  }

  async function dispatchAction(gameAction) {
    try {
      await MP().dispatchGameAction(gameAction);
      syncFromServer();
      flashSync();
      render();
      playSound('pay');
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }

  function isBanker() { return MP().isBanker(); }
  function myPlayerId() { return MP().getPlayerId(); }
  function canControlPlayer(pid) {
    return isBanker() || myPlayerId() === pid;
  }

  function playSound(type) {
    if (!soundsOn) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = type === 'win' ? 880 : type === 'pay' ? 440 : 330;
      g.gain.value = 0.08;
      o.start(); o.stop(ctx.currentTime + 0.12);
    } catch (_) {}
  }

  function captureSnapshot(ids) {
    const snap = { jackpot: state.jackpot, players: {} };
    ids.forEach(id => {
      const p = getPlayer(id);
      if (p) snap.players[id] = { cash: p.cash, loan: p.loan, savings: p.savings, bills: JSON.parse(JSON.stringify(p.bills)), paydayCount: p.paydayCount, salary: p.salary };
    });
    return snap;
  }

  function restoreSnapshot(snap) {
    if (!snap) return;
    state.jackpot = snap.jackpot;
    Object.entries(snap.players || {}).forEach(([id, d]) => {
      const p = getPlayer(id);
      if (p) Object.assign(p, d);
    });
  }

  function trackPeak(p) {
    const nw = p.cash - p.loan;
    if (!state.peakBalances[p.id] || nw > state.peakBalances[p.id]) state.peakBalances[p.id] = nw;
  }

  function logTxn(type, amount, from, to, note, snap) {
    state.transactions.push({ id: uid(), timestamp: Date.now(), type, amount, from, to, note: note || '', undoSnapshot: snap });
  }

  function loanIncrement() { return GE().loanIncrement(state); }
  function calcAutoLoanAmount(shortfall) { return GE().calcAutoLoanAmount(shortfall); }

  function validateLoanTakeAmount(amount) {
    const inc = loanIncrement();
    if (amount < inc) return `Loans must be at least ${money(inc)}.`;
    if (amount % inc !== 0) return `Loans must be taken in ${money(inc)} increments.`;
    return null;
  }

  function validateLoanBalance(remainingLoan) {
    if (remainingLoan <= 0) return null;
    const inc = loanIncrement();
    if (remainingLoan < inc) {
      return `Loan balance cannot be less than ${money(inc)}. Repay in full or leave at least ${money(inc)}.`;
    }
    if (remainingLoan % inc !== 0) {
      return `Loan balance must be in ${money(inc)} increments.`;
    }
    return null;
  }

  function validateRepayIncrement(amount) {
    if (!state.enforceIncrements) return null;
    const inc = editionRules().repayInc;
    if (amount % inc !== 0) return `Repayments must be in ${money(inc)} increments.`;
    return null;
  }

  /** Apply an auto-loan rounded up to official increments (e.g. $200 shortfall → $1,000 loan). */
  function applyAutoLoan(player, shortfall) {
    const loanAmount = calcAutoLoanAmount(shortfall);
    const loanErr = validateLoanTakeAmount(loanAmount);
    if (loanErr) return { ok: false, err: loanErr };
    player.cash += loanAmount;
    player.loan += loanAmount;
    return { ok: true, loanAmount };
  }

  /* ---- Core mutations (no logging) ---- */
  function mutateBankPayment(playerId, amount) { getPlayer(playerId).cash += amount; }
  function mutateBankDeposit(playerId, amount) { getPlayer(playerId).cash -= amount; }
  function mutateTransfer(fromId, toId, amount, allowLoan) {
    const payer = getPlayer(fromId);
    const recip = getPlayer(toId);
    const short = amount - payer.cash;
    if (short > 0) {
      if (!allowLoan) return { ok: false, err: `Insufficient cash (short ${money(short)})` };
      const lr = applyAutoLoan(payer, short);
      if (!lr.ok) return lr;
    }
    if (payer.cash < amount) return { ok: false, err: 'Insufficient cash' };
    payer.cash -= amount; recip.cash += amount;
    return { ok: true };
  }
  function mutateLoan(playerId, amount) {
    const loanErr = validateLoanTakeAmount(amount);
    if (loanErr) return { ok: false, err: loanErr };
    const p = getPlayer(playerId);
    p.cash += amount;
    p.loan += amount;
    return { ok: true };
  }
  function mutateRepay(playerId, amount) {
    const p = getPlayer(playerId);
    if (amount > p.loan) return { ok: false, err: 'Exceeds loan balance' };
    if (amount > p.cash) return { ok: false, err: 'Insufficient cash' };
    const incErr = validateRepayIncrement(amount);
    if (incErr) return { ok: false, err: incErr };
    const remaining = p.loan - amount;
    const balErr = validateLoanBalance(remaining);
    if (balErr) return { ok: false, err: balErr };
    p.cash -= amount;
    p.loan -= amount;
    return { ok: true };
  }
  function mutateJackpotContrib(fromId, amount) {
    const p = getPlayer(fromId);
    if (p.cash < amount) return { ok: false, err: 'Insufficient cash' };
    p.cash -= amount;
    state.jackpot += amount;
    return { ok: true };
  }
  function mutateJackpotPayout(toId, amount) {
    if (amount > state.jackpot) return { ok: false, err: 'Exceeds jackpot' };
    state.jackpot -= amount;
    getPlayer(toId).cash += amount;
    return { ok: true };
  }

  async function doTxn(type, amount, from, to, note, _mutateFn, extra) {
    const action = { type, amount, note: note || '', ...(extra || {}) };
    if (type === 'bank_payment') action.playerId = to;
    else if (['bank_deposit', 'loan_taken', 'jackpot_contribution'].includes(type)) action.playerId = from;
    else if (type === 'player_transfer') { action.playerId = from; action.toPlayerId = to; action.useLoan = !!(extra && extra.useLoan); }
    else if (type === 'jackpot_six') { action.winnerId = extra?.winnerId; delete action.amount; }
    return dispatchAction(action);
  }

  function undo(n) {
    if (!isBanker()) return;
    dispatchAction({ type: 'undo', count: n || 1 });
  }

  /* ---- Payday ---- */
  function calcLoanInterest(p) { return GE().calcLoanInterest(p); }
  function paydayCashAfterInterest(p) { return GE().paydayCashAfterInterest(p); }
  function getPaydayLoanRepayOptions(p) { return GE().getPaydayLoanRepayOptions(state, p); }

  function processPayday(playerId, loanRepayAmount, autoLoan) {
    return dispatchAction({
      type: 'payday', playerId, loanRepayAmount: loanRepayAmount || 0, autoLoan: autoLoan !== false
    });
  }

  /* ---- Modals ---- */
  function closeAllModals() {
    $('#modal-root').innerHTML = '';
    activeModal = null;
  }

  function closeModal() {
    const root = $('#modal-root');
    if (root.lastElementChild) root.lastElementChild.remove();
    if (!root.children.length) activeModal = null;
  }

  function openConfirmModal({ title, message, detailHtml, confirmText, cancelText, danger, onConfirm, onCancel }) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay confirm-overlay';
    ov.onclick = e => {
      if (e.target === ov) { ov.remove(); onCancel?.(); }
    };
    const m = document.createElement('div');
    m.className = 'modal confirm-modal';
    m.setAttribute('role', 'alertdialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = `
      <h3>${title}</h3>
      ${message ? `<p class="confirm-message">${message}</p>` : ''}
      ${detailHtml ? `<div class="confirm-detail">${detailHtml}</div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn" data-cancel>${cancelText || 'Cancel'}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmText || 'Confirm'}</button>
      </div>`;
    m.querySelector('[data-cancel]').onclick = () => { ov.remove(); onCancel?.(); };
    m.querySelector('[data-ok]').onclick = () => { ov.remove(); onConfirm?.(); };
    ov.appendChild(m);
    $('#modal-root').appendChild(ov);
    m.querySelector('[data-ok]').focus();
  }

  function openModal(html, onMount) {
    closeAllModals();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.onclick = e => { if (e.target === ov) closeModal(); };
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = html;
    ov.appendChild(m);
    $('#modal-root').appendChild(ov);
    if (onMount) onMount(m);
    const inp = m.querySelector('input,select,textarea');
    if (inp) inp.focus();
  }

  function noteField(id) {
    const chips = NOTE_PRESETS.map(n => `<button type="button" class="note-chip" data-n="${esc(n)}">${esc(n)}</button>`).join('');
    return `<div class="form-group"><label for="${id}">Note</label><input id="${id}" maxlength="120" placeholder="Optional note"><div class="note-chips">${chips}</div></div>`;
  }

  function wireNotes(m, id) {
    const inp = m.querySelector('#' + id);
    m.querySelectorAll('.note-chip').forEach(c => c.onclick = () => { inp.value = c.dataset.n; m.querySelectorAll('.note-chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); });
  }

  function modalErr(m, msg) { const e = m.querySelector('.error-msg'); if (e) e.textContent = msg; }

  function playerOptions(exclude) {
    return state.players.filter(p => p.id !== exclude).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  }

  function allPlayerOptions() {
    return state.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  }

  function openAmountModal(title, fields, onConfirm) {
    openModal(`<h3>${title}</h3>${fields}<p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Confirm</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelector('[data-ok]').onclick = async () => {
        const r = await onConfirm(m);
        if (r && r.err) modalErr(m, r.err);
        else if (r && r.ok === false) modalErr(m, r.err || 'Failed');
        else if (r !== false) closeModal();
      };
      wireNotes(m, 'note');
    });
  }

  function actionReceive(playerId) {
    const p = getPlayer(playerId);
    openAmountModal(`Receive Money — ${esc(p.name)}`, `<p>Cash: ${money(p.cash)}</p><div class="form-group"><label>Amount</label><input type="number" id="amt" min="1" step="1"></div>${noteField('note')}`, m => {
      const a = parseAmt(m.querySelector('#amt').value);
      if (!a) return { err: 'Enter valid amount' };
      return doTxn('bank_payment', a, 'bank', playerId, m.querySelector('#note').value.trim());
    });
  }

  function actionPay(playerId) {
    const p = getPlayer(playerId);
    openAmountModal(`Pay Money — ${esc(p.name)}`, `<p>Cash: ${money(p.cash)}</p><div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}`, m => {
      const a = parseAmt(m.querySelector('#amt').value);
      if (!a) return { err: 'Enter valid amount' };
      if (p.cash < a) return { err: 'Insufficient cash' };
      return doTxn('bank_deposit', a, playerId, 'bank', m.querySelector('#note').value.trim());
    });
  }

  function actionTransfer(playerId) {
    const p = getPlayer(playerId);
    openModal(`<h3>Transfer — ${esc(p.name)}</h3><p>Cash: ${money(p.cash)}</p>
      <div class="form-group"><label>To</label><select id="to">${playerOptions(playerId)}</select></div>
      <div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}
      <div class="checkbox-row" id="loan-row" hidden><input type="checkbox" id="useloan"><label for="useloan">Take loan for shortfall</label></div>
      <p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Transfer</button></div>`, m => {
      const amtIn = m.querySelector('#amt');
      const loanRow = m.querySelector('#loan-row');
      amtIn.oninput = () => {
        const a = parseAmt(amtIn.value);
        const sh = a ? a - p.cash : 0;
        loanRow.hidden = sh <= 0;
        if (sh > 0) {
          const loanAmt = calcAutoLoanAmount(sh);
          m.querySelector('label[for="useloan"]').textContent =
            loanAmt > sh
              ? `Take loan for ${money(loanAmt)} (${money(sh)} shortfall, min ${money(loanIncrement())} loan)`
              : `Take loan for shortfall (${money(sh)})`;
        }
      };
      m.querySelector('[data-x]').onclick = closeModal;
      wireNotes(m, 'note');
      m.querySelector('[data-ok]').onclick = () => {
        const a = parseAmt(amtIn.value);
        const to = m.querySelector('#to').value;
        const note = m.querySelector('#note').value.trim();
        const sh = a ? a - p.cash : 0;
        const useLoan = sh > 0 && m.querySelector('#useloan').checked;
        if (!a) { modalErr(m, 'Enter valid amount'); return; }
        if (sh > 0 && !useLoan) { modalErr(m, `Insufficient cash. Shortfall: ${money(sh)}`); return; }
        openConfirmModal({
          title: 'Confirm Transfer',
          message: `Transfer <strong>${money(a)}</strong> from <strong>${esc(p.name)}</strong> to <strong>${esc(playerName(to))}</strong>?`,
          confirmText: 'Transfer',
          onConfirm: async () => {
            const r = await doTxn('player_transfer', a, playerId, to, note, null, { useLoan });
            if (r.ok === false) modalErr(m, r.err);
            else closeAllModals();
          }
        });
      };
    });
  }

  function actionLoan(playerId) {
    const p = getPlayer(playerId);
    const inc = loanIncrement();
    openAmountModal(`Take Loan — ${esc(p.name)}`, `<p>Cash: ${money(p.cash)} · Loan: ${money(p.loan)}</p>
      <p style="font-size:0.85rem;color:var(--text-muted)">Loans must be in ${money(inc)} increments (minimum ${money(inc)}).</p>
      <div class="form-group"><label>Amount</label><input type="number" id="amt" min="${inc}" step="${inc}"></div>${noteField('note')}`, m => {
      const a = parseAmt(m.querySelector('#amt').value);
      if (!a) return { err: 'Enter valid amount' };
      return doTxn('loan_taken', a, playerId, 'bank', m.querySelector('#note').value.trim());
    });
  }

  function actionAddBill(playerId) {
    openModal(`<h3>Add Bill — ${esc(playerName(playerId))}</h3>
      <div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>
      <div class="form-group"><label>Description</label><input id="desc" maxlength="80" placeholder="e.g. Food Bill"></div>
      <p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Add</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelector('[data-ok]').onclick = async () => {
        const a = parseAmt(m.querySelector('#amt').value);
        const desc = m.querySelector('#desc').value.trim() || 'Bill';
        if (!a) { modalErr(m, 'Enter valid amount'); return; }
        const r = await dispatchAction({ type: 'bill_added', playerId, amount: a, description: desc });
        if (!r.ok) modalErr(m, r.err);
        else closeModal();
      };
    });
  }

  function actionPayday(playerId) {
    if (!isBanker()) return;
    const p = getPlayer(playerId);
    const loanInt = calcLoanInterest(p);
    const billsDue = billsTotal(p);
    const repayOptions = getPaydayLoanRepayOptions(p);
    const repaySelect = repayOptions.map(a =>
      `<option value="${a}">${a === 0 ? 'No loan repayment' : money(a)}</option>`
    ).join('');
    const billsHtml = p.bills.length
      ? p.bills.map(b => `<div class="bill-item"><span>${esc(b.description)}</span><span>${money(b.amount)}</span></div>`).join('')
      : '<p>No outstanding bills.</p>';

    openModal(`<h3>Payday — ${esc(p.name)}</h3>
      <p style="font-size:0.85rem;color:var(--text-muted)">Official order: salary → interest → loan repayment → all bills.</p>
      <div class="payday-summary" id="payday-estimate">
        <div class="payday-line"><span>1. Salary</span><span style="color:var(--success)">+${money(p.salary)}</span></div>
        <div class="payday-line"><span>2. Loan interest (10%)</span><span style="color:var(--danger)">-${money(loanInt)}</span></div>
        <div class="payday-line"><span>4. All bills (required)</span><span style="color:var(--warning)">-${money(billsDue)}</span></div>
        <div class="payday-line total"><span>Estimated cash after</span><span id="payday-est-val">—</span></div>
      </div>
      ${p.loan > 0 ? `<div class="form-group"><label>3. Repay loan (Pay Day only, ${money(loanIncrement())} increments)</label>
        <select id="loan-repay">${repaySelect}</select>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.35rem">Current loan: ${money(p.loan)}</p></div>` : ''}
      <p><strong>Outstanding Bills — all must be paid</strong></p>
      <div class="bill-list">${billsHtml}</div>
      <div class="checkbox-row"><input type="checkbox" id="autoloan" checked><label for="autoloan">Auto-loan if insufficient cash (rounded up to ${money(loanIncrement())} increments)</label></div>
      <p class="error-msg"></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Process Payday</button></div>`, m => {
      function updateEstimate() {
        const repay = parseInt(m.querySelector('#loan-repay')?.value || '0', 10) || 0;
        const est = paydayCashAfterInterest(p) - repay - billsDue;
        const el = m.querySelector('#payday-est-val');
        if (el) el.textContent = money(est);
      }
      updateEstimate();
      m.querySelector('#loan-repay')?.addEventListener('change', updateEstimate);
      m.querySelector('[data-x]').onclick = closeAllModals;
      m.querySelector('[data-ok]').onclick = () => {
        const loanRepay = parseInt(m.querySelector('#loan-repay')?.value || '0', 10) || 0;
        const auto = m.querySelector('#autoloan').checked;
        const estCash = paydayCashAfterInterest(p) - loanRepay - billsDue;
        const detailHtml = `
          <div class="payday-line"><span>Salary</span><span style="color:var(--success)">+${money(p.salary)}</span></div>
          <div class="payday-line"><span>Loan interest</span><span style="color:var(--danger)">-${money(loanInt)}</span></div>
          ${loanRepay > 0 ? `<div class="payday-line"><span>Loan repayment</span><span style="color:var(--danger)">-${money(loanRepay)}</span></div>` : ''}
          <div class="payday-line"><span>All bills</span><span style="color:var(--warning)">-${money(billsDue)}</span></div>
          <div class="payday-line total"><span>Cash after Payday</span><span>${money(estCash)}</span></div>
          ${estCash < 0 && auto ? `<p style="margin-top:0.5rem;font-size:0.85rem;color:var(--warning)">Auto-loan of ${money(calcAutoLoanAmount(-estCash))} will be taken.</p>` : ''}`;
        openConfirmModal({
          title: 'Confirm Payday',
          message: `Process Payday for <strong>${esc(p.name)}</strong>?`,
          detailHtml,
          confirmText: 'Yes, Process Payday',
          onConfirm: async () => {
            const r = await processPayday(playerId, loanRepay, auto);
            if (!r.ok) modalErr(m, r.err);
            else { closeAllModals(); playSound('win'); }
          }
        });
      };
    });
  }

  function actionEdit(playerId) {
    if (!isBanker()) return;
    const p = getPlayer(playerId);
    openModal(`<h3>Edit — ${esc(p.name)}</h3>
      <div class="form-group"><label>Name</label><input id="pname" value="${esc(p.name)}" maxlength="30"></div>
      <div class="form-group"><label>Cash</label><input type="number" id="cash" value="${p.cash}"></div>
      <div class="form-group"><label>Loan</label><input type="number" id="loan" value="${p.loan}" min="0"></div>
      <div class="form-group"><label>Salary</label><input type="number" id="salary" value="${p.salary}" min="0"></div>
      <div class="form-group"><label>Reason</label><input id="reason" placeholder="Required note"></div>
      <p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Save</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelector('[data-ok]').onclick = async () => {
        const reason = m.querySelector('#reason').value.trim();
        const newName = m.querySelector('#pname').value.trim();
        if (!reason || !newName) { modalErr(m, 'Name and note required'); return; }
        const cash = parseFloat(m.querySelector('#cash').value);
        const loan = parseFloat(m.querySelector('#loan').value);
        const salary = parseFloat(m.querySelector('#salary').value);
        if ([cash, loan, salary].some(v => !isFinite(v) || v < 0)) { modalErr(m, 'Invalid values'); return; }
        const loanBalErr = validateLoanBalance(loan);
        if (loanBalErr) { modalErr(m, loanBalErr); return; }
        const r = await dispatchAction({ type: 'edit', playerId, name: newName, cash, loan, salary, note: reason });
        if (!r.ok) modalErr(m, r.err);
        else closeModal();
      };
    });
  }

  function actionJackpotContrib(fromPlayer) {
    openModal(`<h3>Contribute to Jackpot — ${esc(playerName(fromPlayer))}</h3>
      <div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}
      <p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Contribute</button></div>`, m => {
      wireNotes(m, 'note');
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelector('[data-ok]').onclick = async () => {
        const a = parseAmt(m.querySelector('#amt').value);
        if (!a) { modalErr(m, 'Enter valid amount'); return; }
        const r = await doTxn('jackpot_contribution', a, fromPlayer, 'jackpot', m.querySelector('#note').value.trim());
        if (r.ok === false) modalErr(m, r.err); else closeModal();
      };
    });
  }

  function lotteryPrizeFromEntrantCount(n) { return GE().lotteryPrizeFromEntrantCount(n); }

  function runLottery(winnerId, entrantIds) {
    return dispatchAction({ type: 'lottery', winnerId, entrantIds }).then(r => {
      if (r.ok) playSound('win');
      return r;
    });
  }

  function actionLottery() {
    if (!isBanker()) return;
    const entrantRows = state.players.map(p => {
      const canAfford = p.cash >= LOTTERY_PLAYER_AMOUNT;
      return `<div class="lottery-entrant">
        <input type="checkbox" class="lot-enter" id="ent-${p.id}" ${canAfford ? '' : 'disabled'}>
        <label for="ent-${p.id}">${esc(p.name)}${canAfford ? '' : ' (cannot afford $100)'}</label>
      </div>`;
    }).join('');

    openModal(`<h3>🎰 Lottery</h3>
      <p style="font-size:0.9rem;color:var(--text-muted)">Bank antes ${money(LOTTERY_BANK_AMOUNT)}. Each player may optionally ante ${money(LOTTERY_PLAYER_AMOUNT)}. Play out the lottery with the game die, then select the winner below.</p>
      <div class="lottery-prize" id="lot-prize">Prize: ${money(LOTTERY_BANK_AMOUNT)}</div>
      <p><strong>Player entries (optional)</strong></p>
      <div class="confirm-detail">${entrantRows}</div>
      <div class="form-group" style="margin-top:1rem">
        <label for="lottery-winner">Winner</label>
        <select id="lottery-winner">${allPlayerOptions()}</select>
      </div>
      <p class="error-msg"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-x>Cancel</button>
        <button type="button" class="btn btn-lottery" data-ok>Award Winner</button>
      </div>`, m => {
      function getEntrants() {
        return state.players.filter(p => {
          const cb = m.querySelector(`#ent-${p.id}`);
          return cb && cb.checked;
        });
      }

      function updatePrize() {
        const n = getEntrants().length;
        m.querySelector('#lot-prize').textContent = `Prize: ${money(lotteryPrizeFromEntrantCount(n))}`;
      }

      state.players.forEach(p => {
        m.querySelector(`#ent-${p.id}`)?.addEventListener('change', updatePrize);
      });

      updatePrize();
      m.querySelector('[data-x]').onclick = closeAllModals;
      m.querySelector('[data-ok]').onclick = () => {
        const winnerId = m.querySelector('#lottery-winner').value;
        const winner = getPlayer(winnerId);
        const entrantIds = getEntrants().map(p => p.id);
        const broke = entrantIds.map(id => getPlayer(id)).filter(p => p && p.cash < LOTTERY_PLAYER_AMOUNT);
        if (broke.length) { modalErr(m, `Some entrants cannot afford ${money(LOTTERY_PLAYER_AMOUNT)}.`); return; }
        const prize = lotteryPrizeFromEntrantCount(entrantIds.length);
        openConfirmModal({
          title: 'Confirm Lottery',
          message: `Award <strong>${money(prize)}</strong> to <strong>${esc(winner.name)}</strong>?`,
          detailHtml: `
            <div class="payday-line"><span>Bank contribution</span><span>${money(LOTTERY_BANK_AMOUNT)}</span></div>
            <div class="payday-line"><span>Player entries</span><span>${entrantIds.length} × ${money(LOTTERY_PLAYER_AMOUNT)}</span></div>
            <div class="payday-line total"><span>Total prize</span><span>${money(prize)}</span></div>`,
          confirmText: 'Award Prize',
          onConfirm: async () => {
            const r = await runLottery(winnerId, entrantIds);
            if (!r.ok) modalErr(m, r.err);
            else { closeAllModals(); confetti(); }
          }
        });
      };
    });
  }

  function actionJackpotRollSix() {
    if (!isBanker()) return;
    if (state.jackpot <= 0) {
      openModal(`<h3>Jackpot</h3><p>The Jackpot is empty. Money is added during the game from board spaces and mail cards.</p>
        <div class="modal-actions"><button type="button" class="btn btn-block" data-x>Close</button></div>`, m => {
        m.querySelector('[data-x]').onclick = closeAllModals;
      });
      return;
    }

    openModal(`<h3>🎲 Rolled a 6 — Jackpot!</h3>
      <p style="font-size:0.9rem;color:var(--text-muted)">Any player who rolls a 6 on their regular turn wins the entire Jackpot.</p>
      <p class="lottery-prize">${money(state.jackpot)}</p>
      <div class="form-group"><label>Who rolled the 6?</label><select id="six-winner">${allPlayerOptions()}</select></div>
      <p class="error-msg"></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-jackpot-six" data-ok>Award Jackpot</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeAllModals;
      m.querySelector('[data-ok]').onclick = () => {
        const pid = m.querySelector('#six-winner').value;
        const winner = getPlayer(pid);
        const amt = state.jackpot;
        openConfirmModal({
          title: 'Confirm Jackpot',
          message: `Award <strong>${money(amt)}</strong> to <strong>${esc(winner.name)}</strong> for rolling a 6?`,
          confirmText: 'Award Jackpot',
          onConfirm: async () => {
            const r = await doTxn('jackpot_six', amt, 'jackpot', pid, 'Rolled a 6 on regular turn', null, { winnerId: pid });
            if (r.ok === false) modalErr(m, r.err);
            else { closeAllModals(); confetti(); playSound('win'); }
          }
        });
      };
    });
  }

  function actionJackpotEdit() {
    if (!isBanker()) return;
    openModal(`<h3>Edit Jackpot</h3><p>Current: ${money(state.jackpot)}</p>
      <div class="form-group"><label>New Amount</label><input type="number" id="amt" min="0" value="${state.jackpot}"></div>
      <div class="form-group"><label>Reason</label><input id="reason"></div>
      <p class="error-msg"></p><div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button type="button" class="btn btn-primary" data-ok>Save</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelector('[data-ok]').onclick = async () => {
        const a = parseFloat(m.querySelector('#amt').value);
        const reason = m.querySelector('#reason').value.trim();
        if (!isFinite(a) || a < 0 || !reason) { modalErr(m, 'Valid amount and reason required'); return; }
        const r = await dispatchAction({ type: 'jackpot_edit', amount: a, note: reason });
        if (!r.ok) modalErr(m, r.err);
        else closeModal();
      };
    });
  }

  function actionManageBills(playerId) {
    const p = getPlayer(playerId);
    const list = p.bills.map(b => `<div class="bill-item"><span>${esc(b.description)} — ${money(b.amount)}</span>
      <span><button type="button" class="btn btn-sm" data-pay="${b.id}">Pay</button>
      ${isBanker() ? `<button type="button" class="btn btn-sm btn-danger" data-rm="${b.id}">Remove</button>` : ''}</span></div>`).join('') || '<p>No bills.</p>';
    openModal(`<h3>Bills — ${esc(p.name)}</h3><div class="bill-list">${list}</div>
      <div class="modal-actions"><button type="button" class="btn btn-block" data-x>Close</button></div>`, m => {
      m.querySelector('[data-x]').onclick = closeModal;
      m.querySelectorAll('[data-pay]').forEach(btn => btn.onclick = () => {
        const b = p.bills.find(x => x.id === btn.dataset.pay);
        if (!b) return;

        async function payBill(useLoan) {
          const r = await dispatchAction({ type: 'bill_paid', playerId, billId: b.id, useLoan: !!useLoan });
          if (!r.ok) {
            openConfirmModal({ title: 'Payment Failed', message: esc(r.err), confirmText: 'OK', cancelText: 'Close', onConfirm: () => {} });
            return;
          }
          closeAllModals();
          actionManageBills(playerId);
        }

        if (p.cash < b.amount) {
          const shortfall = b.amount - p.cash;
          const loanAmt = calcAutoLoanAmount(shortfall);
          const msg = loanAmt > shortfall
            ? `Insufficient cash. Take a <strong>${money(loanAmt)}</strong> loan?<br><span style="font-size:0.9rem;color:var(--text-muted)">${money(shortfall)} needed, rounded to ${money(loanIncrement())} increments.</span>`
            : `Insufficient cash. Take a <strong>${money(loanAmt)}</strong> loan?`;
          openConfirmModal({
            title: 'Confirm Loan',
            message: msg,
            confirmText: 'Take Loan',
            onConfirm: () => { payBill(true); }
          });
          return;
        }
        payBill(false);
      });
      m.querySelectorAll('[data-rm]').forEach(btn => btn.onclick = async () => {
        const b = p.bills.find(x => x.id === btn.dataset.rm);
        if (!b) return;
        const r = await dispatchAction({ type: 'bill_remove', playerId, billId: b.id });
        if (!r.ok) alert(r.err);
        else { closeModal(); actionManageBills(playerId); }
      });
    });
  }

  /* ---- Render ---- */
  function getLeaders() {
    if (!state.players.length) return [];
    const maxNet = Math.max(...state.players.map(netWorth));
    return state.players.filter(p => netWorth(p) === maxNet);
  }

  function getMostDebtors() {
    if (!state.players.length) return [];
    const maxLoan = Math.max(...state.players.map(p => p.loan));
    if (maxLoan <= 0) return [];
    return state.players.filter(p => p.loan === maxLoan);
  }

  function formatLeaderSummary() {
    const leaders = getLeaders();
    if (!leaders.length) return '—';
    if (leaders.length === 1) return leaders[0].name;
    return 'Tie: ' + leaders.map(p => p.name).join(', ');
  }

  function formatDebtSummary() {
    const debtors = getMostDebtors();
    if (!debtors.length) return 'None';
    const amt = money(debtors[0].loan);
    if (debtors.length === 1) return `${debtors[0].name} ${amt}`;
    return `Tie: ${debtors.map(p => p.name).join(', ')} (${amt})`;
  }

  function renderSetup() {
    const count = parseInt($('#setup-count').value, 10) || 4;
    const box = $('#setup-players');
    const existing = [...box.querySelectorAll('[data-name]')].map(i => ({ name: i.value, sal: i.dataset.sal }));
    box.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'player-setup-row';
      row.innerHTML = `<div class="form-group" style="margin:0"><label>Player ${i+1}</label><input data-name value="${esc(existing[i]?.name || 'Player '+(i+1))}" maxlength="30"></div>
        <div class="form-group" style="margin:0"><label>Salary</label><input data-sal type="number" value="${existing[i]?.sal || 3500}" min="0" step="50"></div>`;
      box.appendChild(row);
    }
    $('#setup-starting').value = state.startingBalance || 3500;
    $('#setup-enforce-increments').checked = state.enforceIncrements !== false;
  }

  function renderSummary() {
    const totalCash = state.players.reduce((s, p) => s + p.cash, 0);
    const totalLoans = state.players.reduce((s, p) => s + p.loan, 0);
    const totalBills = state.players.reduce((s, p) => s + billsTotal(p), 0);
    const overallNet = totalCash + state.jackpot - totalLoans - totalBills;
    const items = [
      { label: 'Total Cash', val: money(totalCash), cls: 'cash' },
      { label: 'Total Loans', val: money(totalLoans), cls: 'loan' },
      { label: 'Jackpot', val: money(state.jackpot), cls: 'jackpot' },
      { label: 'Unpaid Bills', val: money(totalBills), cls: totalBills > 0 ? 'danger' : '' },
      { label: 'Overall Net Worth', val: money(overallNet), cls: overallNet >= 0 ? 'cash' : 'danger' },
      { label: 'Leader', val: formatLeaderSummary(), cls: '' },
      { label: 'Most Debt', val: formatDebtSummary(), cls: 'loan' }
    ];
    $('#summary-grid').innerHTML = items.map(i => `<div class="summary-item"><div class="label">${i.label}</div><div class="value ${i.cls}">${esc(i.val)}</div></div>`).join('');
    $('#jackpot-amount').textContent = money(state.jackpot);
    $('#btn-undo').disabled = !state.transactions.length;
  }

  function renderPlayers() {
    const leaders = getLeaders();
    const leaderTie = leaders.length > 1;
    const leaderIds = new Set(leaders.map(p => p.id));
    const grid = $('#player-grid');
    const visible = isBanker() ? state.players : state.players.filter(p => p.id === myPlayerId());
    grid.innerHTML = visible.map(p => {
      const nw = netWorth(p);
      const bt = billsTotal(p);
      const isLeader = leaderIds.has(p.id);
      let cls = 'player-card';
      if (isLeader && !leaderTie) cls += ' is-leader';
      if (isLeader && leaderTie) cls += ' is-tied';
      if (p.cash < 0) cls += ' negative';
      if (bt > 0) cls += ' has-bills';
      if (p.loan > 0) cls += ' has-loan';
      const badge = isLeader ? (leaderTie ? '<span class="tied-badge">TIED</span>' : '<span class="leader-badge">LEADER</span>') : '';
      return `<div class="${cls}">${badge}
        <div class="player-name">${esc(p.name)}</div>
        <div class="balance-row cash"><span>Cash</span><span class="amt">${money(p.cash)}</span></div>
        <div class="balance-row loan"><span>Loan</span><span class="amt">${money(p.loan)}</span></div>
        <div class="balance-row bills"><span>Bills Due</span><span class="amt">${money(bt)}</span></div>
        <div class="player-meta">Net: ${money(nw)} · Salary: ${money(p.salary)} · Paydays: ${p.paydayCount} · Interest: 10%</div>
        <div class="player-actions">
          ${canControlPlayer(p.id) ? `
          <button type="button" class="btn" data-a="recv" data-p="${p.id}">Receive</button>
          <button type="button" class="btn" data-a="pay" data-p="${p.id}">Pay</button>
          <button type="button" class="btn" data-a="xfer" data-p="${p.id}">Transfer</button>
          <button type="button" class="btn" data-a="loan" data-p="${p.id}">Loan</button>
          <button type="button" class="btn" data-a="bill" data-p="${p.id}">Add Bill</button>
          <button type="button" class="btn" data-a="bills" data-p="${p.id}">View Bills</button>
          <button type="button" class="btn" data-a="jackpot" data-p="${p.id}">Jackpot</button>
          ${isBanker() ? `<button type="button" class="btn" data-a="edit" data-p="${p.id}">Edit</button>
          <button type="button" class="btn btn-payday" data-a="payday" data-p="${p.id}">PAYDAY</button>` : ''}` : '<p style="font-size:0.85rem;color:var(--text-muted)">View only</p>'}
        </div></div>`;
    }).join('');
  }

  function filteredHistory() {
    const q = ($('#history-search')?.value || '').toLowerCase();
    const fp = $('#history-filter-player')?.value || '';
    const ft = $('#history-filter-type')?.value || '';
    return state.transactions.filter(t => {
      if (fp && t.from !== fp && t.to !== fp) return false;
      if (ft && t.type !== ft) return false;
      if (q && !(t.note || '').toLowerCase().includes(q) && !playerName(t.from).toLowerCase().includes(q) && !playerName(t.to).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderHistory() {
    const list = $('#history-list');
    const items = [...filteredHistory()].reverse();
    if (!items.length) { list.innerHTML = '<p style="padding:1rem;text-align:center;color:var(--text-muted)">No transactions.</p>'; return; }
    list.innerHTML = items.map(t => `<div class="history-item">
      <div style="font-size:0.7rem;color:var(--text-muted)">${new Date(t.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
      <div><span class="history-type">${TXN_LABELS[t.type]||t.type}</span>
        <div>${esc(playerName(t.from))} → ${esc(playerName(t.to))}</div>
        ${t.note?`<div style="font-size:0.8rem;color:var(--text-muted);font-style:italic">${esc(t.note)}</div>`:''}</div>
      <div class="history-amt">${t.amount?money(t.amount):'—'}</div></div>`).join('');
    const fp = $('#history-filter-player');
    const ft = $('#history-filter-type');
    if (fp && fp.options.length <= 1) {
      fp.innerHTML = '<option value="">All Players</option>' + state.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    }
    if (ft && ft.options.length <= 1) {
      ft.innerHTML = '<option value="">All Types</option>' + Object.entries(TXN_LABELS).map(([k,v]) => `<option value="${k}">${v}</option>`).join('');
    }
  }

  function renderBanker() {
    $('#banker-quick').innerHTML = `
      <button type="button" class="btn btn-sm" data-bk="recv">Bank Pay Player</button>
      <button type="button" class="btn btn-sm" data-bk="dep">Player Pay Bank</button>
      <button type="button" class="btn btn-sm btn-jackpot-six" data-bk="jackpot-six">Rolled a 6!</button>
      <button type="button" class="btn btn-sm btn-lottery" data-bk="lottery">Run Lottery</button>`;
    $('#banker-quick').onclick = e => {
      const b = e.target.closest('[data-bk]');
      if (!b) return;
      if (b.dataset.bk === 'recv') openModal(`<h3>Bank Pay Player</h3><div class="form-group"><label>Player</label><select id="pl">${allPlayerOptions()}</select></div><div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}<p class="error-msg"></p><div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Pay</button></div>`, m => {
        wireNotes(m,'note'); m.querySelector('[data-x]').onclick=closeModal;
        m.querySelector('[data-ok]').onclick=async ()=>{ const a=parseAmt(m.querySelector('#amt').value); const pid=m.querySelector('#pl').value; if(!a){modalErr(m,'Amount required');return;} const r=await doTxn('bank_payment',a,'bank',pid,m.querySelector('#note').value.trim()); if(r.ok===false)modalErr(m,r.err);else closeModal(); };
      });
      if (b.dataset.bk === 'dep') openModal(`<h3>Player Pay Bank</h3><div class="form-group"><label>Player</label><select id="pl">${allPlayerOptions()}</select></div><div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}<p class="error-msg"></p><div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Pay</button></div>`, m => {
        wireNotes(m,'note'); m.querySelector('[data-x]').onclick=closeModal;
        m.querySelector('[data-ok]').onclick=async ()=>{ const a=parseAmt(m.querySelector('#amt').value); const pid=m.querySelector('#pl').value; const p=getPlayer(pid); if(!a){modalErr(m,'Amount required');return;} if(p.cash<a){modalErr(m,'Insufficient cash');return;} const r=await doTxn('bank_deposit',a,pid,'bank',m.querySelector('#note').value.trim()); if(r.ok===false)modalErr(m,r.err);else closeModal(); };
      });
      if (b.dataset.bk === 'jackpot-six') actionJackpotRollSix();
      if (b.dataset.bk === 'lottery') actionLottery();
    };
    $('#banker-table').innerHTML = `<thead><tr><th>Player</th><th>Cash</th><th>Loan</th><th>Bills</th><th>Net</th><th>Paydays</th></tr></thead><tbody>
      ${state.players.map(p=>`<tr><td>${esc(p.name)}</td><td>${money(p.cash)}</td><td>${money(p.loan)}</td><td>${money(billsTotal(p))}</td><td>${money(netWorth(p))}</td><td>${p.paydayCount}</td></tr>`).join('')}
    </tbody>`;
  }

  function computeStats() {
    const stats = {};
    state.players.forEach(p => {
      stats[p.id] = { loans: 0, earned: 0, paid: 0, billsPaid: 0, jackpotWins: 0 };
    });
    let largest = { amount: 0, who: '' };
    state.transactions.forEach(t => {
      if (t.type === 'loan_taken' && stats[t.from]) stats[t.from].loans += t.amount;
      if (t.type === 'bank_payment' && stats[t.to]) stats[t.to].earned += t.amount;
      if (t.type === 'bank_deposit' && stats[t.from]) stats[t.from].paid += t.amount;
      if (t.type === 'bill_paid' && stats[t.from]) stats[t.from].billsPaid += t.amount;
      if ((t.type === 'jackpot_payout' || t.type === 'jackpot_six' || t.type === 'lottery_draw') && stats[t.to]) stats[t.to].jackpotWins += t.amount;
      if (t.amount > largest.amount) largest = { amount: t.amount, who: playerName(t.from) + ' → ' + playerName(t.to) };
    });
    const mostLoans = state.players.reduce((a, b) => (stats[a.id]?.loans||0) >= (stats[b.id]?.loans||0) ? a : b);
    const mostEarned = state.players.reduce((a, b) => (stats[a.id]?.earned||0) >= (stats[b.id]?.earned||0) ? a : b);
    const mostPaid = state.players.reduce((a, b) => (stats[a.id]?.paid||0) >= (stats[b.id]?.paid||0) ? a : b);
    const mostBills = state.players.reduce((a, b) => (stats[a.id]?.billsPaid||0) >= (stats[b.id]?.billsPaid||0) ? a : b);
    const peak = state.players.reduce((a, b) => (state.peakBalances[a.id]||0) >= (state.peakBalances[b.id]||0) ? a : b);
    const mostJack = state.players.reduce((a, b) => (stats[a.id]?.jackpotWins||0) >= (stats[b.id]?.jackpotWins||0) ? a : b);
    return { mostLoans, mostEarned, mostPaid, mostBills, peak, mostJack, largest };
  }

  function renderStats() {
    const s = computeStats();
    const loanTotal = id => state.transactions.filter(t => t.type === 'loan_taken' && t.from === id).reduce((a, t) => a + t.amount, 0);
    const stat = id => state.transactions.reduce((acc, t) => {
      if (t.type === 'bank_payment' && t.to === id) acc.earned += t.amount;
      if (t.type === 'bank_deposit' && t.from === id) acc.paid += t.amount;
      if (t.type === 'bill_paid' && t.from === id) acc.bills += t.amount;
      if ((t.type === 'jackpot_payout' || t.type === 'jackpot_six' || t.type === 'lottery_draw') && t.to === id) acc.jack += t.amount;
      return acc;
    }, { earned: 0, paid: 0, bills: 0, jack: 0 });
    $('#stats-grid').innerHTML = [
      ['Most Loans Taken', `${s.mostLoans.name} — ${money(loanTotal(s.mostLoans.id))}`],
      ['Most Money Earned', `${s.mostEarned.name} — ${money(stat(s.mostEarned.id).earned)}`],
      ['Most Money Paid', `${s.mostPaid.name} — ${money(stat(s.mostPaid.id).paid)}`],
      ['Most Bills Paid', `${s.mostBills.name} — ${money(stat(s.mostBills.id).bills)}`],
      ['Highest Balance Reached', `${s.peak.name} — ${money(state.peakBalances[s.peak.id] || 0)}`],
      ['Largest Transaction', `${money(s.largest.amount)} (${s.largest.who})`],
      ['Most Jackpot Wins', `${s.mostJack.name} — ${money(stat(s.mostJack.id).jack)}`]
    ].map(([h, v]) => `<div class="stat-card"><h3>${h}</h3><div class="val">${esc(v)}</div></div>`).join('');
  }

  function renderLeaderboard() {
    const sorted = [...state.players].sort((a, b) => netWorth(b) - netWorth(a));
    $('#leaderboard-list').innerHTML = sorted.map((p, i) => {
      const nw = netWorth(p);
      const tied = sorted.filter(x => netWorth(x) === nw).length > 1;
      const rank = sorted.findIndex(x => netWorth(x) === nw) + 1;
      const label = tied ? `${rank}. ${esc(p.name)} (tied)` : `${rank}. ${esc(p.name)}`;
      return `<li><span>${label}</span><span>${money(nw)}</span></li>`;
    }).join('');
  }

  function renderLobby() {
    const code = MP().getRoomCode();
    const claimed = MP().claimedPlayerIds();
    const link = MP().joinLink();
    const slots = (state.players || []).map(p => {
      const sess = MP().sessionForPlayer(p.id);
      const taken = claimed.has(p.id);
      const isMe = myPlayerId() === p.id;
      const online = taken && MP().isPlayerOnline(p.id);
      return `<div class="lobby-slot ${taken ? 'claimed' : ''}">
        <strong>${esc(p.name)}</strong>
        <span>${taken ? (sess ? esc(sess.display_name) + (online ? ' · online' : ' · away') : 'Claimed') : 'Available'}</span>
        ${!taken && MP().session?.role === 'player' ? `<button type="button" class="btn btn-sm btn-primary" data-claim="${p.id}">Claim</button>` : ''}
        ${isMe ? '<span class="leader-badge">YOU</span>' : ''}
      </div>`;
    }).join('');

    $('#lobby-code').textContent = code || '—';
    $('#lobby-link').value = link;
    $('#lobby-slots').innerHTML = slots || '<p>No players configured.</p>';
    $('#lobby-sessions').innerHTML = MP().sessions.map(s =>
      `<div class="lobby-session">${esc(s.display_name)} · ${s.role}${s.player_id ? ' · ' + esc(playerName(s.player_id)) : ''}</div>`
    ).join('');
    $('#btn-start-lobby').hidden = !isBanker();
    $('#lobby-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(link)}`;

    $('#lobby-slots').onclick = e => {
      const b = e.target.closest('[data-claim]');
      if (!b) return;
      claimPlayerSlot(b.dataset.claim);
    };
  }

  async function claimPlayerSlot(playerId) {
    try {
      await MP().claimPlayer(playerId);
      syncFromServer();
      render();
    } catch (e) { alert(e.message); }
  }

  function applyRoleUI() {
    const banker = isBanker();
    document.querySelector('.jackpot-bar')?.classList.toggle('banker-only-hidden', !banker);
    $$('.nav-btn[data-tab="banker"]').forEach(b => { b.hidden = !banker; });
    $('#banker-toolbar')?.classList.toggle('banker-only', banker);
    $$('#tab-history .toolbar button, #btn-new-game, #btn-reset').forEach(b => {
      if (b) b.hidden = !banker;
    });
    if (!banker) switchTab('game');
  }

  function render() {
    document.documentElement.dataset.theme = state.theme || 'light';
    updateRoomStatus();

    const sess = MP().session;
    $('#view-home').hidden = !!sess;
    $('#view-create').hidden = true;

    if (!sess) {
      $('#view-lobby').hidden = true;
      $('#view-game').hidden = true;
      return;
    }

    syncFromServer();
    const inLobby = MP().getGameStatus() === 'lobby' || !state.gameStarted;

    if (inLobby) {
      $('#view-lobby').hidden = false;
      $('#view-game').hidden = true;
      renderLobby();
      return;
    }

    $('#view-lobby').hidden = true;
    $('#view-game').hidden = false;
    applyRoleUI();
    renderSummary();
    renderPlayers();
    renderHistory();
    if (isBanker()) renderBanker();
    renderStats();
    renderLeaderboard();
  }

  function switchTab(tab) {
    ['game','banker','history','stats','leaderboard'].forEach(t => {
      $('#tab-' + t).hidden = t !== tab;
      $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    });
  }

  async function createGame() {
    const names = [...$$('[data-name]')].map(i => i.value.trim());
    const salaries = [...$$('[data-sal]')].map(i => parseFloat(i.value));
    const start = parseFloat($('#setup-starting').value);
    if (names.some(n => !n)) { $('#setup-error').textContent = 'All names required.'; return; }
    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) { $('#setup-error').textContent = 'Names must be unique.'; return; }
    if (!isFinite(start) || start < 0) { $('#setup-error').textContent = 'Invalid starting balance.'; return; }
    $('#setup-error').textContent = '';
    try {
      await MP().createGame({
        playerNames: names,
        salaries,
        startingBalance: start,
        enforceIncrements: $('#setup-enforce-increments').checked,
        bankerName: $('#banker-name').value.trim() || 'Banker'
      });
      syncFromServer();
      history.replaceState(null, '', `?room=${MP().getRoomCode()}`);
      render();
    } catch (e) { $('#setup-error').textContent = e.message; }
  }

  async function joinGame() {
    const code = $('#join-code').value.trim().toUpperCase();
    const name = $('#join-name').value.trim();
    if (!code) { $('#join-error').textContent = 'Enter room code.'; return; }
    $('#join-error').textContent = '';
    try {
      await MP().joinGame(code, name || 'Player');
      syncFromServer();
      history.replaceState(null, '', `?room=${code}`);
      render();
    } catch (e) { $('#join-error').textContent = e.message; }
  }

  async function startLobbyGame() {
    try {
      await MP().startGame();
      syncFromServer();
      render();
    } catch (e) { alert(e.message); }
  }

  function exportCSV(rows, filename) {
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
  }

  function confetti() {
    const c = $('#confetti-canvas');
    c.hidden = false;
    const ctx = c.getContext('2d');
    c.width = innerWidth; c.height = innerHeight;
    const pieces = Array.from({length: 120}, () => ({ x: Math.random()*c.width, y: -20-Math.random()*c.height, r: 4+Math.random()*6, c: `hsl(${Math.random()*360},80%,55%)`, vy: 2+Math.random()*4, vx: -2+Math.random()*4 }));
    let frame = 0;
    function draw() {
      ctx.clearRect(0,0,c.width,c.height);
      pieces.forEach(p => { p.x+=p.vx; p.y+=p.vy; ctx.fillStyle=p.c; ctx.fillRect(p.x,p.y,p.r,p.r); });
      frame++;
      if (frame < 180) requestAnimationFrame(draw); else { c.hidden = true; }
    }
    draw();
  }

  function showWinner() {
    const leaders = getLeaders();
    const ov = document.createElement('div');
    ov.className = 'winner-overlay';
    const body = leaders.length === 1
      ? `<h2>🎉 Winner!</h2><p style="font-size:1.5rem;font-weight:800">${esc(leaders[0].name)}</p><p>Net worth: ${money(netWorth(leaders[0]))}</p>`
      : `<h2>🤝 It's a Tie!</h2><p style="font-size:1.25rem;font-weight:800">${esc(leaders.map(p => p.name).join(', '))}</p><p>Net worth: ${money(netWorth(leaders[0]))}</p>`;
    ov.innerHTML = `<div class="winner-card">${body}<button type="button" class="btn btn-primary btn-block" style="margin-top:1rem">Close</button></div>`;
    ov.querySelector('button').onclick = () => ov.remove();
    document.body.appendChild(ov);
    confetti(); playSound('win');
  }

  function bind() {
    $('#setup-count').onchange = renderSetup;
    $('#btn-create-game').onclick = createGame;
    $('#btn-show-create').onclick = () => { $('#view-home').hidden = true; $('#view-create').hidden = false; renderSetup(); };
    $('#btn-show-join').onclick = () => { $('#view-home').hidden = true; $('#view-join').hidden = false; };
    $('#btn-back-home').onclick = () => { $('#view-create').hidden = true; $('#view-join').hidden = true; $('#view-home').hidden = false; };
    $('#btn-back-home-join').onclick = () => { $('#view-join').hidden = true; $('#view-home').hidden = false; };
    $('#btn-join-game').onclick = joinGame;
    $('#btn-start-lobby').onclick = startLobbyGame;
    $('#btn-copy-link').onclick = () => { navigator.clipboard?.writeText($('#lobby-link').value); };
    $('#btn-leave').onclick = () => { if (confirm('Leave this game?')) { MP().clearSession(); state = defaultState(); history.replaceState(null, '', location.pathname); render(); } };
    $('#btn-theme').onclick = () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; saveTheme(); render(); };
    $('#btn-sound').onclick = () => { soundsOn = !soundsOn; $('#btn-sound').textContent = soundsOn ? '🔊 Sound' : '🔇 Sound'; };
    $('#btn-new-game').onclick = () => { if (confirm('Leave and start fresh?')) { MP().clearSession(); state = defaultState(); history.replaceState(null, '', location.pathname); render(); } };
    $('#btn-reset').onclick = () => { if (confirm('Reset all balances?')) dispatchAction({ type: 'reset' }); };
    $('#btn-clear-save').onclick = () => { if (confirm('Clear session?')) { MP().clearSession(); state = defaultState(); render(); } };
    $('#btn-undo').onclick = () => undo(1);
    $('#btn-undo-multi').onclick = () => { const n = parseInt(prompt('How many transactions to undo?', '1'), 10); if (n > 0) undo(n); };
    $('#btn-clear-history').onclick = () => { if (confirm('Clear history not supported in multiplayer.')) {} };
    $('#btn-export-txn').onclick = () => exportCSV([['Time','Type','Amount','From','To','Note'], ...state.transactions.map(t => [new Date(t.timestamp).toISOString(), TXN_LABELS[t.type]||t.type, t.amount, playerName(t.from), playerName(t.to), t.note])], 'payday-transactions.csv');
    $('#btn-export-balances').onclick = () => exportCSV([['Player','Cash','Loan','Bills','Net Worth','Paydays'], ...state.players.map(p => [p.name, p.cash, p.loan, billsTotal(p), netWorth(p), p.paydayCount])], 'payday-balances.csv');
    $('#btn-export-json').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state,null,2)])); a.download = 'payday-save.json'; a.click(); };
    $('#btn-print').onclick = () => window.print();
    $('#btn-winner').onclick = showWinner;
    $$('.nav-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $('#history-search').oninput = renderHistory;
    $('#history-filter-player').onchange = renderHistory;
    $('#history-filter-type').onchange = renderHistory;

    $('#player-grid').onclick = e => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a, p = b.dataset.p;
      ({ recv: actionReceive, pay: actionPay, xfer: actionTransfer, loan: actionLoan, bill: actionAddBill, bills: actionManageBills, payday: actionPayday, edit: actionEdit, jackpot: id => actionJackpotContrib(id) })[a]?.(p);
    };

    document.querySelector('.jackpot-actions').onclick = e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      ({ 'jackpot-contrib-player': () => openModal(`<h3>Player Contribute</h3><div class="form-group"><label>Player</label><select id="pl">${allPlayerOptions()}</select></div><div class="form-group"><label>Amount</label><input type="number" id="amt" min="1"></div>${noteField('note')}<p class="error-msg"></p><div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn btn-primary" data-ok>Go</button></div>`, m => {
        wireNotes(m,'note'); m.querySelector('[data-x]').onclick=closeModal;
        m.querySelector('[data-ok]').onclick=async ()=>{ const a=parseAmt(m.querySelector('#amt').value); const pid=m.querySelector('#pl').value; if(!a){modalErr(m,'Amount');return;} const r=await doTxn('jackpot_contribution',a,pid,'jackpot',m.querySelector('#note').value.trim()); if(r.ok===false)modalErr(m,r.err);else closeModal(); };
      }), 'jackpot-six': actionJackpotRollSix, 'lottery': actionLottery, 'jackpot-edit': actionJackpotEdit })[b.dataset.action]?.();
    };

    document.onkeydown = e => { if (e.key === 'Escape') closeModal(); };
  }

  async function init() {
    loadTheme();
    soundsOn = false;
    bind();
    MP().setOnUpdate(() => { syncFromServer(); render(); });

    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    try {
      if (MP().loadSession()?.sessionId) {
        await MP().reconnect();
      } else if (room) {
        $('#join-code').value = room;
        $('#view-home').hidden = true;
        $('#view-join').hidden = false;
      }
      syncFromServer();
    } catch (e) {
      console.warn('Reconnect failed', e);
      MP().clearSession();
    }
    render();
  }

  init();
})();
  