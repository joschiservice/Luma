import { formatNumber } from '@luma/i18n/format';

type Point = {
  key: string;
  label: string;
  values: { count: number };
  unknown?: string | undefined;
};

/** Draws a line through known values, leaving gaps for unknown observations; pair it with its data table. */
export function LinePlot({
  points,
  label,
}: {
  points: Point[];
  label: string;
}) {
  const known = points.filter((point) => !point.unknown);
  const minimum = Math.min(0, ...known.map((point) => point.values.count));
  const maximum = Math.max(1, ...known.map((point) => point.values.count));
  const x = (index: number) =>
    56 + (index * 564) / Math.max(1, points.length - 1);
  const y = (value: number) =>
    180 - ((value - minimum) * 156) / (maximum - minimum);
  const paths: string[] = [];
  let path = '';
  points.forEach((point, index) => {
    if (point.unknown) {
      if (path) paths.push(path);
      path = '';

      return;
    }
    path += `${path ? 'L' : 'M'}${x(index)},${y(point.values.count)} `;
  });
  if (path) paths.push(path);

  return (
    <svg
      className="adaptive-line-plot"
      viewBox="0 0 640 220"
      role="img"
      aria-label={label}
    >
      <line className="adaptive-line-axis" x1="56" x2="620" y1="180" y2="180" />
      <text x="8" y="30">
        {formatNumber(maximum)}
      </text>
      <text x="8" y="184">
        {formatNumber(minimum)}
      </text>
      {paths.map((segment, index) => (
        <path className="adaptive-line-path" d={segment} key={index} />
      ))}
      {points.map((point, index) =>
        point.unknown ? null : (
          <circle
            className="adaptive-line-point"
            cx={x(index)}
            cy={y(point.values.count)}
            r="3"
            key={point.key}
          >
            <title>
              {point.label}: {formatNumber(point.values.count)}
            </title>
          </circle>
        ),
      )}
      <text x="56" y="208">
        {points[0]?.label}
      </text>
      <text x="620" y="208" textAnchor="end">
        {points.at(-1)?.label}
      </text>
    </svg>
  );
}
