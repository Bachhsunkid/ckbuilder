// Recompute the SPEC section 3 numbers from the formulas, in integer shannons.
const SHANNON = 1e8;
const C = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); };
const payout = (stakeShannons, k, m) => {
  const gross = Math.floor(stakeShannons * C(9, k) / C(9 - m, k));
  const profit = gross - stakeShannons;
  const fee = Math.ceil(profit * 5 / 100);
  return { gross, profit, fee, payout: gross - fee };
};
const ckb = (s) => (s / SHANNON).toFixed(2);

console.log('== SPEC example: stake 100, Easy, k=3 ==');
const ex = payout(100 * SHANNON, 3, 2);
console.log('gross', ckb(ex.gross), 'profit', ckb(ex.profit), 'fee', ckb(ex.fee), 'payout', ckb(ex.payout));

for (const [name, m] of [['Easy', 2], ['Medium', 3], ['Hard', 4]]) {
  const safe = 9 - m;
  const maxM = C(9, safe) / C(9 - m, safe);
  const collat = C(9, m) - 1;
  console.log(`\n== ${name} (${m} mines) ==`);
  console.log('max multiplier', maxM + 'x', '| P(clear board) = 1/' + maxM, '| collateral', collat + 'x stake', '| max stake at 2500 cap', (2500 / collat).toFixed(1));
  console.log('k  mult    nextTileMineRisk  edge(5% of profit)  edge/collateral');
  for (let k = 1; k <= safe; k++) {
    const M = C(9, k) / C(9 - m, k);
    const edge = 0.05 * (1 - 1 / M);
    const risk = k === safe ? '-' : (m / (9 - k) * 100).toFixed(0) + '%';
    console.log(String(k).padEnd(2), (M.toFixed(2) + 'x').padEnd(8), String(risk).padEnd(17), (edge * 100).toFixed(2).padStart(5) + '%', '            ', (edge / collat * 100).toFixed(3) + '%');
  }
  console.log('risk of the very first tile:', (m / 9 * 100).toFixed(0) + '%');
}

console.log('\n== Rounding: 25 CKB, Easy, k=1 ==');
const real = payout(25 * SHANNON, 1, 2);
console.log('shannons -> payout', ckb(real.payout), 'CKB, fee', ckb(real.fee), 'CKB');
const whole = payout(25, 1, 2);
console.log('whole-CKB units (as in the prototype) -> payout', whole.payout, 'CKB, fee', whole.fee, 'CKB');

console.log('\n== EV check: every stopping rule has the same expected return before the fee ==');
for (const [name, m] of [['Easy', 2], ['Hard', 4]]) {
  const row = [];
  for (let k = 1; k <= 9 - m; k++) { const M = C(9, k) / C(9 - m, k); row.push(((1 / M) * M).toFixed(3)); }
  console.log(name, 'P(survive k) x M(k) =', row.join(' '));
}
