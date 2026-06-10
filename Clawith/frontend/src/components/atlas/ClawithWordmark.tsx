interface Props {
    /** Rendered height in px (width scales to preserve the source aspect ratio). */
    height?: number;
    className?: string;
}

/**
 * Shared brand mark for the LaboFlow-branded Clawith surfaces.
 */
export default function ClawithWordmark({ height = 32, className }: Props) {
    return (
        <img
            src="/laboflow-logo-transparent.svg"
            alt="LaboFlow"
            className={className}
            style={{ height, width: 'auto', display: 'block' }}
            decoding="async"
        />
    );
}
