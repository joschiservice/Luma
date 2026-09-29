import postcss from 'postcss';

const rawColor =
  /#[\da-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\s*\(/i;
const appearance =
  /^(?:color|background(?:-.+)?|border(?:-.+)?|box-shadow|font(?:-.+)?|line-height|letter-spacing|padding(?:-.+)?|fill|stroke)$/;
const primitiveSelector =
  /\[data-slot\s*=\s*['"]?(?:card|badge|alert|button)(?:-[\w-]+)?['"]?\]|\.ui-(?:card|badge|alert|button)(?:-[\w-]+)?\b/;

/** Finds literal colors and appearance overrides targeting shared primitives in CSS. */
export function cssFindings(source, filename) {
  const findings = [];
  postcss.parse(source, { from: filename }).walkDecls((declaration) => {
    const selector =
      declaration.parent.type === 'rule' ? declaration.parent.selector : '';
    const add = (rule) =>
      findings.push({
        rule,
        line: declaration.source.start.line,
        signature: `${rule}: ${selector} { ${declaration.prop}: ${declaration.value} }`,
      });
    // Mask colors describe opacity, not visible theme colors.
    if (!declaration.prop.includes('mask') && rawColor.test(declaration.value))
      add('raw-color');
    if (primitiveSelector.test(selector) && appearance.test(declaration.prop))
      add('primitive-appearance');
  });

  return findings;
}

/** Reports literal CSS colors in a style value, including token fallbacks. */
export function hasRawColor(value) {
  return rawColor.test(value);
}
