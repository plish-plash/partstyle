/** KiCad paper sizes, smallest first (mm, landscape). */
export const papers: [name: string, w: number, h: number][] = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
];

/** Index into `papers` of the smallest sheet a layout fits, clear of the frame and title block. */
export const paperFor = (s: { width: number; height: number }) => {
  const i = papers.findIndex(([, w, h]) => w >= s.width + 10 && h >= s.height + 35);
  return i < 0 ? papers.length - 1 : i;
};
