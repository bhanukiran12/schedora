const rasterCache=new Map();
function raster(data,onload){let image=rasterCache.get(data);if(!image){image=new Image();image.onload=()=>onload?.();image.onerror=()=>rasterCache.delete(data);image.src=data;rasterCache.set(data,image);if(rasterCache.size>50)rasterCache.delete(rasterCache.keys().next().value)}return image.complete&&image.naturalWidth?image:null;}
export function columnOffsets(count, width) {
  const offsets = [0];
  for (let column = 0; column < count; column++) offsets.push(offsets[column] + width(column));
  return offsets;
}

export function viewportColumns(offsets, left, width, overscan = 0) {
  const count = offsets.length - 1;
  const columnAt = x => {
    let start = 0;
    let end = count;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (offsets[middle + 1] <= x) start = middle + 1; else end = middle;
    }
    return start;
  };
  return { first: Math.max(0, columnAt(left) - overscan), last: Math.min(count, columnAt(left + Math.max(0, width - 0.01)) + 1 + overscan) };
}

export function columnBands(offsets, left, width, gutter, frozen = 0, overscan = 0) {
  const edge = gutter + offsets[frozen];
  const viewport = viewportColumns(offsets, left + offsets[frozen], Math.max(0, width - edge), overscan);
  return [
    { first: Math.max(frozen, viewport.first), last: viewport.last, clipLeft: edge, clipRight: width, scroll: left },
    { first: 0, last: frozen, clipLeft: gutter, clipRight: Math.min(edge, width), scroll: 0 }
  ];
}

function wrappedLines(context, text, width, maxLines) {
  const lines = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > width) {
        lines.push(line);
        if (lines.length >= maxLines) return lines;
        line = word;
      } else line = next;
    }
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

export function paintSheetGrid(canvas, model) {
  const context = canvas.getContext('2d');
  if (!context) return false;
  const { width, height, scale, blocks, offsets, left, gutter, rowHeight: defaultHeight, frozenColumns = 0, zoom = 1, colors, selection, extraRanges = [], anchor, readCell, mergedCell, mergeGeometry } = model;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
  if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  if (width <= gutter || height < 1) return true;
  const bands = columnBands(offsets, left, width, gutter, frozenColumns);
  const contains = (region, row, column) => row >= region.r1 && row <= region.r2 && column >= region.c1 && column <= region.c2;
  const multiple = extraRanges.length || selection.r1 !== selection.r2 || selection.c1 !== selection.c2;
  for (const block of blocks) for (const band of bands) {
    if (block.bottom <= block.top || band.clipRight <= band.clipLeft) continue;
    // Clip independently at the frozen boundary so scrolling rows cannot paint over frozen cells.
    context.save();
    context.beginPath();
    context.rect(band.clipLeft, block.top, band.clipRight - band.clipLeft, block.bottom - block.top);
    context.clip();
    const overflowText=[];
    const painted = mergedCell ? new Set() : null;
    for (const point of block.rows) {
      for (let visible = band.first; visible < band.last; visible++) {
        const merge = mergedCell?.(point.row, visible);
        if (merge && painted.has(merge)) continue;
        if (merge) painted.add(merge);
        const row = merge?.r1 ?? point.row;
        const column = merge?.c1 ?? visible;
        const endRow = merge?.r2 ?? row;
        const endColumn = merge?.c2 ?? column;
        const geometry = merge && mergeGeometry(merge);
        const y = geometry?.y ?? point.y;
        const rowHeight = geometry?.height ?? point.height ?? defaultHeight;
        const x = gutter + offsets[column] - band.scroll;
        const w = offsets[endColumn + 1] - offsets[column];
        if(w<=0)continue;
        const cell = readCell(row, column);
        const format = cell.format ?? {};
        const selected = contains(selection, row, column) ? selection : extraRanges.find(region => contains(region, row, column));
        const selectedColor = selected && multiple ? colors.selection : '';
        context.fillStyle = format.fill || (cell.found ? colors.found : colors.background);
        context.fillRect(x, y, w, rowHeight);
        if (selectedColor && !format.fill && !cell.found) {
          context.fillStyle = selectedColor;
          context.fillRect(x, y, w, rowHeight);
        }
        if (colors.line) {
          context.fillStyle = colors.line;
          context.fillRect(x + w - 1, y, 1, rowHeight);
          context.fillRect(x, y + rowHeight - 1, w, 1);
        }
        if (format.border) {
          context.fillStyle = colors.ink;
          if (format.border.includes('t')) context.fillRect(x, y, w, 1);
          if (format.border.includes('r')) context.fillRect(x + w - 1, y, 1, rowHeight);
          if (format.border.includes('b')) context.fillRect(x, y + rowHeight - 1, w, 1);
          if (format.border.includes('l')) context.fillRect(x, y, 1, rowHeight);
        }
        const control = format.validation?.kind;
        if (control === 'list' || control === 'checkbox') {
          context.fillStyle = colors.ink;
          context.font = `${13 * zoom}px sans-serif`;
          context.textBaseline = 'middle';
          context.textAlign = control === 'checkbox' ? 'center' : 'right';
          context.fillText(control === 'checkbox' ? (cell.value === true ? '☑' : '☐') : '▾', control === 'checkbox' ? x + w / 2 : x + w - 5, y + rowHeight / 2);
        }
        if(format.image){const image=raster(format.image,model.onImageLoad);if(image){const ratio=Math.min((w-6)/image.naturalWidth,(rowHeight-4)/image.naturalHeight);context.drawImage(image,x+3,y+2,image.naturalWidth*ratio,image.naturalHeight*ratio)}}
        if (cell.text && control !== 'checkbox' && !format.image) {
          const drawText=()=>{
          context.save();
          context.beginPath();
          const reserved = control === 'list' ? 12 : 0;
          let textWidth=w;
          if(format.overflow&&!format.wrap&&!format.rotation&&!format.vertical&&!cell.number&&(!format.align||format.align==='left'))for(let next=endColumn+1;next<band.last;next++){const other=readCell(row,next);if(other.text||other.format?.fill||other.format?.image)break;textWidth+=offsets[next+1]-offsets[next]}
          context.rect(x + 4, y, Math.max(0, textWidth - 8 - reserved), rowHeight);
          context.clip();
          context.fillStyle = format.color || (cell.error ? colors.error : colors.ink);
          const align = format.align || (cell.number ? 'right' : cell.bool || cell.error ? 'center' : 'left');
          context.textAlign = align;
          context.textBaseline = 'middle';
          const size = (format.size ?? 13) * zoom;
          context.font = `${format.i ? 'italic ' : ''}${format.b ? '700 ' : ''}${size}px ${format.font || colors.font}`;
          const textX = align === 'right' ? x + w - 5 - reserved : align === 'center' ? x + (w - reserved) / 2 : x + 5;
          const lineHeight = size * 1.25;
          const lines = format.vertical ? [...String(cell.text)].slice(0,Math.max(1,Math.floor(rowHeight/lineHeight))) : format.wrap ? wrappedLines(context, String(cell.text), w - 10, Math.max(1, Math.floor((rowHeight - 4) / lineHeight))) : String(cell.text).split(/\r?\n/, 1);
          lines.forEach((text, index) => {
            const textY = format.valign==='top'?y+size*.65+2+index*lineHeight:format.valign==='bottom'?y+rowHeight-size*.65-2-(lines.length-1-index)*lineHeight:y+rowHeight/2-(lines.length-1)*lineHeight/2+index*lineHeight;
            context.save();context.translate(textX,textY);if(format.rotation)context.rotate(-format.rotation*Math.PI/180);
            context.fillText(text,0,0);
            if (format.u || format.s) {
              const measured = context.measureText(text).width;
              const start = -(align === 'right' ? measured : align === 'center' ? measured / 2 : 0);
              if (format.u) context.fillRect(start, size * .36, measured, 1);
              if (format.s) context.fillRect(start,0,measured,1);
            }
            context.restore();
          });
          context.restore();
          };
          if(format.overflow)overflowText.push(drawText);else drawText();
        }
        if (format.note) {
          context.fillStyle = colors.note;
          context.beginPath(); context.moveTo(x + w - 8, y); context.lineTo(x + w, y); context.lineTo(x + w, y + 8); context.fill();
        }
        const active = row === anchor.r && column === anchor.c;
        if (selected || cell.viewer || cell.reference) {
          context.fillStyle = cell.reference ? '#7c3aed' : active || selected ? colors.selectionLine : cell.viewer;
          const allEdges = active || cell.viewer || cell.reference;
          const thickness = allEdges ? 2 : 1;
          if (allEdges || row === selected.r1) context.fillRect(x, y, w, thickness);
          if (allEdges || endRow === selected.r2) context.fillRect(x, y + rowHeight - thickness, w, thickness);
          if (allEdges || column === selected.c1) context.fillRect(x, y, thickness, rowHeight);
          if (allEdges || endColumn === selected.c2) context.fillRect(x + w - thickness, y, thickness, rowHeight);
        }
      }
    }
    for(const draw of overflowText)draw();
    context.restore();
  }
  context.save();context.beginPath();context.rect(gutter,model.contentTop??0,width-gutter,height);context.clip();
  for(const item of model.images??[]){const image=raster(item.data,model.onImageLoad);if(image)context.drawImage(image,item.x,item.y,item.width*zoom,item.height*zoom)}
  context.restore();
  return true;
}
