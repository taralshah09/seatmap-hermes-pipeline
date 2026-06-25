export function generateSeatmapHTML(layout) {
  // Classify sections into a 2-row × 3-col grid by id and angle
  // Upper tier: balcony / mezzanine  |  Lower tier: orchestra / generic
  // Column: angle < 0 → left, angle > 0 → right, angle === 0 → center
  // When multiple sections share the same cell, stack them vertically.

  const classify = s => {
    const isUpper = /balcony|mezzanine/i.test(s.id);
    let col;
    if (s.angle < 0)      col = 'left';
    else if (s.angle > 0) col = 'right';
    else                  col = 'center';
    return { ...s, tier: isUpper ? 'upper' : 'lower', col };
  };

  const sections = layout.sections.map(classify);

  const cellSections = (tier, col) =>
    sections.filter(s => s.tier === tier && s.col === col);

  const renderSeat = (seatNum, rowId, row) => {
    const isWheelchair = row.special?.wheelchair?.includes(seatNum);
    const isCompanion  = row.special?.companion?.includes(seatNum);
    const isRestricted = row.special?.restricted?.includes(seatNum);
    let cls = 'seat';
    if (isWheelchair) cls += ' wheelchair';
    if (isCompanion)  cls += ' companion';
    if (isRestricted) cls += ' restricted';
    return `<button class="${cls}" data-row="${rowId}" data-seat="${seatNum}" title="${rowId}${seatNum}">${seatNum}</button>`;
  };

  const renderRow = row => {
    const seatsHtml = row.seats.map(n => renderSeat(n, row.rowId, row)).join('');
    return `<div class="row" data-row-id="${row.rowId}">
      <span class="row-label">${row.rowId}</span>
      <div class="seats">${seatsHtml}</div>
      <span class="row-label">${row.rowId}</span>
    </div>`;
  };

  const renderSection = s => `
    <div class="section" id="section-${s.id}">
      <div class="section-label">${s.label}</div>
      ${s.rows.map(renderRow).join('')}
    </div>`;

  const renderCell = (tier, col) => {
    const list = cellSections(tier, col);
    if (!list.length) return `<div class="cell cell-${col}"></div>`;
    // Side sections get a subtle lean toward center
    const skew = col === 'left' ? 'skewY(-2deg)' : col === 'right' ? 'skewY(2deg)' : '';
    const style = skew ? `style="transform:${skew};transform-origin:center bottom;"` : '';
    return `<div class="cell cell-${col}" ${style}>${list.map(renderSection).join('')}</div>`;
  };

  const stageAtTop = layout.venue?.stagePosition === 'top';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Seatmap</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f8fafc; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; padding: 20px 10px; }

  /* ── overall layout ── */
  .tier { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; width: 100%; max-width: 1200px; align-items: end; }
  .tier-upper { margin-bottom: 12px; }
  .tier-lower { margin-bottom: 16px; }

  .cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .cell-left  { align-items: flex-end; }
  .cell-right { align-items: flex-start; }
  .cell-center { align-items: center; }

  /* ── sections ── */
  .section { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .section-label { font-size: 10px; font-weight: 700; color: #666; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }

  /* ── rows ── */
  .row { display: flex; align-items: center; gap: 3px; }
  .row-label { font-size: 9px; font-weight: 700; color: #999; width: 16px; text-align: center; flex-shrink: 0; }
  .seats { display: flex; gap: 2px; flex-wrap: nowrap; }

  /* ── seats ── */
  .seat { width: 18px; height: 18px; border-radius: 3px; border: 1px solid #bcd;
          background: #e8f4fd; font-size: 7px; cursor: pointer; color: #334;
          display: flex; align-items: center; justify-content: center;
          transition: background 0.12s; flex-shrink: 0; }
  .seat:hover { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  .seat.selected { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  .seat.wheelchair { background: #fef3c7; border-color: #f59e0b; }
  .seat.companion  { background: #d1fae5; border-color: #10b981; }
  .seat.restricted { background: #fee2e2; border-color: #ef4444; opacity: 0.55; cursor: not-allowed; }

  /* ── stage ── */
  .stage-wrap { width: 100%; max-width: 1200px; display: flex; justify-content: center; margin-bottom: 24px; }
  .stage-wrap.stage-top { margin-bottom: 0; margin-top: 0; order: -1; }
  .stage { width: 280px; height: 36px; background: #1a1a2e; color: #fff; text-align: center;
           line-height: 36px; font-size: 12px; letter-spacing: 3px; font-weight: 600; }
  .stage-wrap.stage-bottom .stage { border-radius: 6px 6px 0 0; }
  .stage-wrap.stage-top    .stage { border-radius: 0 0 6px 6px; margin-bottom: 24px; }

  /* ── legend ── */
  #legend { display: flex; gap: 14px; margin-top: 16px; flex-wrap: wrap; justify-content: center; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #555; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 3px; border: 1px solid #ccc; flex-shrink: 0; }
</style>
</head>
<body>

  ${stageAtTop ? `<!-- STAGE at the top -->
  <div class="stage-wrap stage-top">
    <div class="stage">STAGE</div>
  </div>` : ''}

  <!-- UPPER TIER: balconies + mezzanine -->
  <div class="tier tier-upper">
    ${renderCell('upper', 'left')}
    ${renderCell('upper', 'center')}
    ${renderCell('upper', 'right')}
  </div>

  <!-- LOWER TIER: orchestra sections -->
  <div class="tier tier-lower">
    ${renderCell('lower', 'left')}
    ${renderCell('lower', 'center')}
    ${renderCell('lower', 'right')}
  </div>

  ${!stageAtTop ? `<!-- STAGE at the bottom -->
  <div class="stage-wrap stage-bottom">
    <div class="stage">STAGE</div>
  </div>` : ''}

  <div id="legend">
    <div class="legend-item"><div class="legend-swatch" style="background:#e8f4fd;border-color:#bcd"></div> Available</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#1d4ed8;border-color:#1d4ed8"></div> Selected</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#fef3c7;border-color:#f59e0b"></div> Wheelchair</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#d1fae5;border-color:#10b981"></div> Companion</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#fee2e2;border-color:#ef4444"></div> Restricted</div>
  </div>

<script>
  document.querySelectorAll('.seat:not(.restricted)').forEach(btn =>
    btn.addEventListener('click', () => btn.classList.toggle('selected'))
  );
</script>
</body>
</html>`;
}
