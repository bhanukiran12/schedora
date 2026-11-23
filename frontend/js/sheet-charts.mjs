const COLORS = ['#176f47', '#3260ad', '#b34b24', '#7252a0', '#a52f70', '#917015', '#37777d', '#5a6771'];

export function chartSeries(values, firstRowLabels) {
  const width = values[0]?.length ?? 0;
  const categories = width > 1;
  const data = firstRowLabels ? values.slice(1) : values;
  const labels = data.map((row, index) => categories ? String(row[0] || index + 1) : String(index + 1));
  const series = Array.from({ length: width - Number(categories) }, (_, index) => {
    const column = index + Number(categories);
    return { label: firstRowLabels ? String(values[0][column] || `Series ${index + 1}`) : `Series ${index + 1}`,
      values: data.map(row => typeof row[column] === 'number' && Number.isFinite(row[column]) ? row[column] : null) };
  }).filter(series => series.values.some(value => value !== null));
  return { labels, series };
}

export function drawChart(canvas, { labels, series }, type) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !labels.length || !series.length) return false;
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.font = '14px sans-serif';
  if (type === 'pie') {
    const values = series[0].values;
    const total = values.reduce((count, value) => count + (value ?? 0), 0);
    if (!(total > 0) || values.some(value => value < 0)) return false;
    let from = -Math.PI / 2;
    values.forEach((value, index) => {
      if (!value) return;
      const to = from + value / total * Math.PI * 2;
      ctx.fillStyle = COLORS[index % COLORS.length];
      ctx.beginPath(); ctx.moveTo(width / 2, height / 2); ctx.arc(width / 2, height / 2, height * 0.44, from, to); ctx.closePath(); ctx.fill();
      from = to;
    });
    return true;
  }
  const data = series.flatMap(set => set.values.filter(value => value !== null));
  const low = Math.min(0, ...data);
  const high = Math.max(0, ...data);
  const plotWidth = width - 80;
  const plotHeight = height - 64;
  const left = 64;
  const top = 16;
  const y = value => top + (high - value) / (high - low || 1) * plotHeight;
  const step = plotWidth / labels.length;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let index = 0; index <= 4; index++) {
    const value = low + (high - low || 1) * index / 4;
    ctx.fillStyle = '#e1e6e3';
    ctx.fillRect(left, y(value), plotWidth, 1);
    ctx.fillStyle = '#35423c';
    ctx.fillText(String(Number(value.toPrecision(3))), left - 6, y(value));
  }
  series.forEach((set, index) => {
    const color = COLORS[index % COLORS.length];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let previous = false;
    set.values.forEach((value, row) => {
      if (value === null) { previous = false; return; }
      if (type === 'line') {
        const x = left + (row + 0.5) * step;
        if (previous) ctx.lineTo(x, y(value)); else ctx.moveTo(x, y(value));
        previous = true;
        ctx.fillRect(x - 2, y(value) - 2, 4, 4);
      } else {
        const barWidth = step * 0.8 / series.length;
        ctx.fillRect(left + row * step + step * 0.1 + index * barWidth, Math.min(y(0), y(value)), Math.max(1, barWidth - 1), Math.max(1, Math.abs(y(value) - y(0))));
      }
    });
    if (type === 'line') ctx.stroke();
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = '#35423c';
  labels.forEach((label, index) => {
    if (index % Math.ceil(labels.length / 10) === 0) ctx.fillText(label.slice(0, 18), left + (index + 0.5) * step, height - 26, Math.min(68, step * Math.ceil(labels.length / 10)));
  });
  return true;
}

export const chartColor = index => COLORS[index % COLORS.length];
