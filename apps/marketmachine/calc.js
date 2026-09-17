// PUT IN: apps/marketmachine/calc.js
/**
 * The five calculations, each with its formula, inputs, sources, and whether
 * it is an estimate or an actual.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { CALC_INPUTS } from '../../lib/marketmachine/calculations.js';
import { esc, fmtStamp, fmtMoney } from './format.js';

export default function makeCalc(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function fmtCalcValue(v, unit, input) {
      if (v === null || v === undefined) return '';
      if (input && input.display) return esc(input.display);
      if (unit === 'money') return fmtMoney(v);
      if (unit === 'percent') return esc(v) + '%';
      return esc(Number(v).toLocaleString());
    }

    function inputUnit(label) {
      if (/rate/i.test(label)) return 'percent';
      if (/value|profit|expense/i.test(label)) return 'money';
      return 'count';
    }

    function calculationsSection(c, meta) {
      const calcs = (state.detail && state.detail.calculations) || [];
      if (!calcs.length) return '';
      const cards = calcs.map((k) => `
        <div class="mk-calc">
          <div class="t"><h4>${esc(k.title)}</h4>
            <span class="pill ${k.basis === 'actual' ? 'ok' : 'src'}">${k.basis === 'actual' ? 'Actual' : 'Estimate'}</span></div>
          ${k.value === null
            ? `<div class="st">${esc(k.status || 'Not enough to calculate yet')}</div>`
            : `<div class="r${k.unit === 'percent' && k.value < 0 ? ' neg' : ''}">${fmtCalcValue(k.value, k.unit)}${k.unit === 'orders' ? ' <span style="font-size:14px;font-weight:600;color:var(--muted)">orders</span>' : ''}</div>`}
          <div class="f">${esc(k.formula)}</div>
          <table><tbody>${k.inputs.map((i) => `<tr>
            <td>${esc(i.label)}<div class="src">${esc(i.source)}${i.by ? ', ' + esc(i.by) : ''}</div></td>
            <td class="v">${i.value === null ? '<span class="src">Missing</span>' : fmtCalcValue(i.value, inputUnit(i.label), i)}</td>
          </tr>`).join('')}</tbody></table>
          <div class="up">${k.updatedAt ? 'Last updated ' + esc(fmtStamp(k.updatedAt)) : 'Nothing entered yet'}</div>
        </div>`).join('');

      const inputs = (state.detail.campaign.calc && state.detail.campaign.calc.inputs) || {};
      const editor = state.calcEditing ? `
        <div class="mk-card"><div class="mk-card-hd"><h3>Numbers that are typed in</h3>
          <span class="meta">Leave a number blank when it is not known. Blank is not zero.</span></div>
          <div class="mk-card-bd">
            <div class="mk-inputs">${Object.entries(CALC_INPUTS).filter(([, spec]) => !spec.strategic || meta.parent).map(([key, spec]) => {
              const cur = inputs[key] || {};
              return `<div class="mk-field">
                <label for="mkCalc-${key}">${esc(spec.label)}${spec.kind === 'percent' ? ' (%)' : spec.kind === 'money' ? ' ($)' : ''}</label>
                ${spec.hint ? `<div class="hint">${esc(spec.hint)}</div>` : ''}
                <input type="text" id="mkCalc-${key}" inputmode="decimal" value="${cur.value != null ? esc(cur.value) : ''}">
                ${spec.kind !== 'count' ? `<input type="text" id="mkCalcSrc-${key}" maxlength="200" style="margin-top:6px"
                  placeholder="Where it came from, e.g. Apparelytics 2025 average" value="${esc(cur.source || '')}">` : ''}
                ${cur.at ? `<div class="hint" style="margin-top:4px">Set by ${esc(cur.by || 'someone')}, ${esc(fmtStamp(cur.at))}</div>` : ''}
              </div>`;
            }).join('')}</div>
            <button class="mk-btn" data-act="calc-save-all">Save numbers</button>
          </div></div>` : '';

      return `
        <h2 style="font-size:17px;font-weight:800;margin:26px 0 6px">calculations.</h2>
        <div class="mk-scope" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
          <span>Every number shows where it came from. Connected leads and TravelTrack receipts are read live; everything else is typed.</span>
          <button class="mk-btn ghost sm" data-act="calc-edit">${state.calcEditing ? 'Done entering numbers' : 'Enter numbers'}</button>
        </div>
        ${msgBox(state.calcMsg)}
        ${editor}
        <div class="mk-calcs">${cards}</div>`;
    }

  return { fmtCalcValue, inputUnit, calculationsSection };
}
