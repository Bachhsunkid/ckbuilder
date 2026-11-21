'use client';

import { useEffect, useRef, useState } from 'react';

// Guide for new visitors. It opens by itself on the first visit, and on every
// visit when "Show on every visit" is ticked; the floating button opens it any
// time. Uses the native <dialog> so focus trapping, Escape and returning focus
// on close come from the browser.
const autoKey = 'ckb-cinema:guide-auto-v1'; // 'on' | 'off'; missing = first visit
const readAuto = () => { try { return localStorage.getItem(autoKey); } catch { return null; } };
const writeAuto = (value: 'on' | 'off') => { try { localStorage.setItem(autoKey, value); } catch { /* storage blocked */ } };

type Step = { title: string; body: string; target?: string[]; route?: boolean };

const steps: Step[] = [
  {
    title: 'Pay per film. The payment is the key.',
    body: 'Watch any trailer for free. Pay 1 to 5 CKB only for the film you want, with no subscription and no account. Settling the Fiber payment is what hands your browser the secret that unlocks the film.',
  },
  {
    title: 'Three nodes, one route',
    body: 'You pay the studio through Bottle B, a public Fiber Testnet node. Bottle only forwards: its payment is locked to the same hash as yours, so it cannot keep your CKB, and it never sees your ticket.',
    route: true,
  },
  {
    title: 'First, play the studio',
    body: 'In the Projection room, start both nodes and open their channels to Bottle B. Then print a film: pick its master from samples/films/. Your browser checks it, encrypts it and puts the ciphertext on the CDN. Nothing is uploaded.',
    target: ['booth'],
  },
  {
    title: 'Then, buy a ticket',
    body: 'Press Buy a ticket on any film. The studio writes a Fiber invoice and wraps the film key with a fresh secret. Your browser checks the invoice, the price and the file before you pay. Try to play without paying: it fails.',
    target: ['checkout', 'now'],
  },
  {
    title: 'Pay, unlock, watch',
    body: 'Press Pay. When the payment settles, the secret arrives, your browser checks it against the payment hash, unwraps the key, decrypts the film and plays it. Every check is listed on your ticket.',
    target: ['checkout', 'now'],
  },
];

export default function Intro() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [everyVisit, setEveryVisit] = useState(false);

  const open = () => {
    setStep(0);
    dialog.current?.showModal();
  };

  useEffect(() => {
    const auto = readAuto();
    setEveryVisit(auto === 'on');
    if (auto !== 'off') dialog.current?.showModal();
  }, []);

  // After the first visit the guide stops opening by itself unless ticked.
  const onClose = () => { if (readAuto() !== 'on') writeAuto('off'); };
  const toggleEveryVisit = (on: boolean) => {
    setEveryVisit(on);
    writeAuto(on ? 'on' : 'off');
  };

  const showMe = (ids: string[]) => {
    dialog.current?.close();
    const element = ids.map((id) => document.getElementById(id)).find(Boolean);
    element?.scrollIntoView({ block: 'start' });
  };

  const current = steps[step];
  const last = step === steps.length - 1;

  return <>
    <button type="button" className="guide-fab mono" onClick={open} aria-haspopup="dialog"><span aria-hidden="true">?</span> Guide</button>
    <dialog ref={dialog} className="intro" aria-labelledby="intro-title" aria-describedby="intro-body" onClose={onClose}>
      <div className="intro-head">
        <span className="mono kicker">Guide · {String(step + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')}</span>
        <button type="button" className="intro-close" onClick={() => dialog.current?.close()} aria-label="Close the guide">×</button>
      </div>
      <div className="sprockets" aria-hidden="true" />
      <div className="intro-body">
        <h2 id="intro-title" className="intro-title">{current.title}</h2>
        {current.route && <ol className="intro-route" aria-label="Payment route">
          <li><b>Viewer A</b><span className="mono small dim">you, the buyer</span></li>
          <li aria-hidden="true" className="intro-arrow">→</li>
          <li><b>Bottle B</b><span className="mono small dim">public node, forwards only</span></li>
          <li aria-hidden="true" className="intro-arrow">→</li>
          <li><b>Studio C</b><span className="mono small dim">the seller</span></li>
        </ol>}
        <p id="intro-body">{current.body}</p>
        {last && <p className="small"><a href="/litepaper">Read the one-page litepaper</a></p>}
      </div>
      <div className="intro-foot">
        <div className="intro-dots" aria-hidden="true">{steps.map((_, index) => <span key={index} className={index === step ? 'on' : ''} />)}</div>
        <div className="row">
          {current.target && <button type="button" className="btn" onClick={() => showMe(current.target!)}>Show me</button>}
          {step > 0 && <button type="button" className="btn" onClick={() => setStep((s) => s - 1)}>Back</button>}
          {last
            ? <button type="button" className="btn solid" onClick={() => dialog.current?.close()}>Start watching</button>
            : <button type="button" className="btn solid" onClick={() => setStep((s) => s + 1)}>Next</button>}
        </div>
      </div>
      <div className="intro-options">
        <label className="intro-check mono small"><input type="checkbox" checked={everyVisit} onChange={(event) => toggleEveryVisit(event.target.checked)} /> Show on every visit</label>
        {!last && <button type="button" className="intro-skip mono small" onClick={() => dialog.current?.close()}>Skip the guide</button>}
      </div>
    </dialog>
  </>;
}
