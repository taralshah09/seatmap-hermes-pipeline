export function renderSeatmapHTML(layout) {
  const stageAtTop = layout.venue?.stagePosition === 'top';

  const seatType = (num, row) => {
    if (row.special?.wheelchair?.includes(num)) return 'wheelchair';
    if (row.special?.companion?.includes(num))  return 'companion';
    if (row.special?.restricted?.includes(num)) return 'restricted';
    return 'available';
  };

  const secs = layout.sections.map(sec => {
    const rowsHtml = sec.rows.map(row => {
      const seatsHtml = row.seats.map(n => {
        const t = seatType(n, row);
        return `<button class="seat ${t}" title="${row.rowId}${n}">${n}</button>`;
      }).join('');
      return `<div class="row"><span class="rl">${row.rowId}</span><div class="sw">${seatsHtml}</div><span class="rl">${row.rowId}</span></div>`;
    }).join('');
    return `<div class="sec" data-sec="${sec.id}"><div class="sl">${sec.label}</div>${rowsHtml}</div>`;
  }).join('');

  const stageHTML = '<div class="stage">STAGE</div>';
  const body = stageAtTop
    ? stageHTML + `<div class="map">${secs}</div>`
    : `<div class="map">${secs}</div>` + stageHTML;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Seatmap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#f8fafc;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.stage{width:260px;height:34px;background:#1f6feb;color:#fff;text-align:center;line-height:34px;border-radius:6px;font-size:12px;letter-spacing:3px;font-weight:700;margin:0 auto 20px}
.map{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:20px}
.sec{display:flex;flex-direction:column;gap:2px;align-items:center}
.sl{font-size:10px;font-weight:700;color:#555;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
.row{display:flex;align-items:center;gap:3px}
.rl{font-size:9px;font-weight:700;color:#999;width:15px;text-align:center}
.sw{display:flex;gap:2px}
.seat{width:18px;height:18px;border-radius:3px;border:1px solid #ccc;background:#e8f4fd;font-size:7px;cursor:pointer;color:#333;display:flex;align-items:center;justify-content:center;transition:background .12s}
.seat:hover{background:#3b82f6;color:#fff}
.seat.selected{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
.seat.wheelchair{background:#fef3c7;border-color:#f59e0b}
.seat.companion{background:#d1fae5;border-color:#10b981}
.seat.restricted{background:#fee2e2;border-color:#ef4444;opacity:.55;cursor:not-allowed}
</style>
</head>
<body>
${body}
<script>document.querySelectorAll(".seat:not(.restricted)").forEach(b=>b.addEventListener("click",()=>b.classList.toggle("selected")));<\/script>
</body>
</html>`;
}
