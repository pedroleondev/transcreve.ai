const PDFDocument = require('pdfkit');
const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

/**
 * Formata segundos em formato de legenda SRT (HH:MM:SS,mmm)
 */
function formatSRTTime(seconds) {
  const date = new Date(seconds * 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const mmm = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Formata segundos em formato de legenda VTT (HH:MM:SS.mmm)
 */
function formatVTTTime(seconds) {
  const date = new Date(seconds * 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const mmm = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Gera conteúdo TXT
 */
function generateTXT(transcription, segments = [], includeTimestamps = false) {
  if (!includeTimestamps || !segments || segments.length === 0) {
    return transcription.raw_text || '';
  }

  return segments.map(seg => {
    const timeStr = `[${formatSRTTime(seg.start_time).split(',')[0]}]`;
    const speakerStr = seg.speaker ? `${seg.speaker}: ` : '';
    return `${timeStr} ${speakerStr}${seg.text}`;
  }).join('\n\n');
}

/**
 * Gera formato de Legendas SRT
 */
function generateSRT(segments = []) {
  if (!segments || segments.length === 0) return '1\n00:00:00,000 --> 00:00:05,000\nSem legendas gravadas.';

  return segments.map((seg, index) => {
    const seq = index + 1;
    const start = formatSRTTime(seg.start_time);
    const end = formatSRTTime(seg.end_time);
    const speaker = seg.speaker ? `[${seg.speaker}] ` : '';
    return `${seq}\n${start} --> ${end}\n${speaker}${seg.text}\n`;
  }).join('\n');
}

/**
 * Gera formato de Legendas WebVTT
 */
function generateVTT(segments = []) {
  let vtt = 'WEBVTT - Gerado por TurboScribe Local\n\n';
  if (!segments || segments.length === 0) return vtt + '00:00:00.000 --> 00:00:05.000\nSem legendas.';

  vtt += segments.map((seg, index) => {
    const start = formatVTTTime(seg.start_time);
    const end = formatVTTTime(seg.end_time);
    const speaker = seg.speaker ? `<v ${seg.speaker}>` : '';
    return `${index + 1}\n${start} --> ${end}\n${speaker}${seg.text}`;
  }).join('\n\n');

  return vtt;
}

/**
 * Gera documento DOCX (Microsoft Word)
 */
async function generateDOCX(transcription, segments = [], includeTimestamps = false) {
  const paragraphs = [
    new Paragraph({
      text: transcription.file_name || 'Transcrição TurboScribe',
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Data: ${new Date(transcription.created_at).toLocaleString('pt-BR')}`, italic: true }),
        new TextRun({ text: `  |  Duração: ${Math.round(transcription.duration_seconds || 0)}s`, italic: true }),
        new TextRun({ text: `  |  Modo: ${transcription.mode || 'Golfinho'}`, italic: true })
      ],
      spacing: { after: 400 }
    })
  ];

  if (includeTimestamps && segments.length > 0) {
    segments.forEach(seg => {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: `[${formatSRTTime(seg.start_time).split(',')[0]}] `, bold: true, color: '0066FF' }),
            new TextRun({ text: seg.speaker ? `${seg.speaker}: ` : '', bold: true }),
            new TextRun({ text: seg.text })
          ],
          spacing: { after: 150 }
        })
      );
    });
  } else {
    paragraphs.push(
      new Paragraph({
        text: transcription.raw_text || '',
        spacing: { after: 200 }
      })
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }]
  });

  return await Packer.toBuffer(doc);
}

/**
 * Gera documento PDF formatado
 */
function generatePDF(transcription, segments = [], includeTimestamps = false, callback) {
  const doc = new PDFDocument({ margin: 50 });
  const buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {
    const pdfData = Buffer.concat(buffers);
    callback(null, pdfData);
  });

  // Cabeçalho PDF TurboScribe
  doc.fillColor('#0066FF').fontSize(22).text('TurboScribe', { inline: true });
  doc.fillColor('#666666').fontSize(10).text('   SaaS Local de Transcrição', { inline: true });
  doc.moveDown(1.5);

  doc.fillColor('#111111').fontSize(16).text(transcription.file_name || 'Transcrição');
  doc.fillColor('#777777').fontSize(9).text(
    `Gerado em: ${new Date(transcription.created_at).toLocaleString('pt-BR')} | Idioma: ${transcription.language || 'pt'} | Modo: ${transcription.mode || 'golfinho'}`
  );
  doc.moveDown(1);
  doc.strokeColor('#EEEEEE').lineWidth(1).moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(1.5);

  doc.fillColor('#222222').fontSize(11);

  if (includeTimestamps && segments.length > 0) {
    segments.forEach(seg => {
      const timeTag = `[${formatSRTTime(seg.start_time).split(',')[0]}] `;
      doc.fillColor('#0066FF').font('Helvetica-Bold').text(timeTag, { continued: true });
      if (seg.speaker) {
        doc.fillColor('#333333').font('Helvetica-Bold').text(`${seg.speaker}: `, { continued: true });
      }
      doc.fillColor('#222222').font('Helvetica').text(seg.text);
      doc.moveDown(0.5);
    });
  } else {
    doc.font('Helvetica').text(transcription.raw_text || '', {
      align: 'justify',
      lineGap: 4
    });
  }

  doc.end();
}

module.exports = {
  generateTXT,
  generateSRT,
  generateVTT,
  generateDOCX,
  generatePDF
};
