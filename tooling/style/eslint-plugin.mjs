import { hasRawColor } from './ui-policy.mjs';

const appearanceClass =
  /^(?:bg-|text-(?:xs|sm|base|lg|xl|\d?xl|\[|white|black|red-|blue-|green-|foreground|muted)|border(?:-|$)|rounded(?:-|$)|shadow(?:$|-(?:sm|md|lg|xl|2xl|none|inner)$|-\[)|font-|p[xytrblse]?-)/;

export default {
  rules: {
    'module-scope-message': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          moduleScope:
            'Call message and formatting functions while rendering. At module scope the text is fixed in the language the module first loaded in; store the function instead.',
        },
      },
      create(context) {
        const localized = new Set();
        const sources = new Set([
          '@luma/i18n/messages',
          '@luma/i18n/format',
          '@luma/i18n/rich',
        ]);
        const functions = new Set([
          'FunctionDeclaration',
          'FunctionExpression',
          'ArrowFunctionExpression',
        ]);

        return {
          ImportDeclaration(node) {
            if (!sources.has(node.source.value)) return;
            for (const specifier of node.specifiers)
              localized.add(specifier.local.name);
          },
          CallExpression(node) {
            const callee =
              node.callee.type === 'MemberExpression'
                ? node.callee.object
                : node.callee;
            if (callee.type !== 'Identifier' || !localized.has(callee.name))
              return;
            const ancestors = context.sourceCode.getAncestors(node);
            if (!ancestors.some((ancestor) => functions.has(ancestor.type)))
              context.report({ node, messageId: 'moduleScope' });
          },
        };
      },
    },
    'primitive-appearance': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          appearance:
            'Use the shared primitive’s variants for appearance; keep layout classes on its container.',
          color: 'Use a semantic CSS token instead of a literal color.',
        },
      },
      create(context) {
        const primitives = new Set();
        const report = (node, messageId) => {
          context.report({ node, messageId });
        };

        return {
          ImportDeclaration(node) {
            if (
              !node.source.value.startsWith('@luma/ui/components/primitives/')
            )
              return;
            for (const specifier of node.specifiers)
              primitives.add(specifier.local.name);
          },
          JSXAttribute(node) {
            const name = node.name.name;
            if (
              !['style', 'className', 'fill', 'stroke', 'color'].includes(name)
            )
              return;
            const component = node.parent.name;
            const shared =
              (component.type === 'JSXIdentifier' &&
                primitives.has(component.name)) ||
              (component.type === 'JSXMemberExpression' &&
                component.object.type === 'JSXIdentifier' &&
                primitives.has(component.object.name));
            const visit = (value) => {
              if (!value || typeof value !== 'object') return;
              const text =
                value.type === 'Literal' && typeof value.value === 'string'
                  ? value.value
                  : value.type === 'TemplateElement'
                    ? value.value.raw
                    : null;
              if (text !== null) {
                if (name !== 'className' && hasRawColor(text))
                  report(value, 'color');
                if (
                  name === 'className' &&
                  shared &&
                  text
                    .split(/\s+/)
                    .some((part) =>
                      appearanceClass.test(part.split(':').at(-1)),
                    )
                )
                  report(value, 'appearance');
              }
              if (
                name === 'style' &&
                shared &&
                value.type === 'Property' &&
                /^(?:color|background\w*|border\w*|padding\w*|font\w*|boxShadow|lineHeight)$/.test(
                  value.key.name ?? value.key.value,
                )
              )
                report(value, 'appearance');
              for (const [key, child] of Object.entries(value)) {
                if (
                  ['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)
                )
                  continue;
                if (Array.isArray(child)) child.forEach(visit);
                else if (child && typeof child === 'object') visit(child);
              }
            };
            visit(node.value);
          },
        };
      },
    },
  },
};
