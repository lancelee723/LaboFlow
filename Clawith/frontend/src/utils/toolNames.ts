import i18n from '../i18n';

/**
 * Return a localized, human-readable display name for a tool object.
 *
 * Look-up order:
 *  1. enterprise.tools.toolNames[tool.name]  (i18n translation)
 *  2. tool.display_name
 *  3. tool.name
 */
export function getLocalizedToolDisplayName(tool: { name?: string; display_name?: string; [key: string]: any }): string {
    const name = tool?.name ?? '';
    if (name) {
        const key = `enterprise.tools.toolNames.${name}`;
        const translated = i18n.t(key, { defaultValue: '' });
        if (translated && translated !== key) {
            return translated;
        }
    }
    return tool?.display_name || name || '';
}
