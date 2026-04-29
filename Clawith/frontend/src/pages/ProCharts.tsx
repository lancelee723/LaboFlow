import { useEffect, useRef } from 'react';

export default function ProCharts() {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    // Forward dark/light theme changes into the iframe via postMessage
    useEffect(() => {
        const sendTheme = () => {
            const theme = document.documentElement.getAttribute('data-theme') || 'light';
            iframeRef.current?.contentWindow?.postMessage({ type: 'theme-change', theme }, '*');
        };

        const observer = new MutationObserver(sendTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
    }, []);

    return (
        <div style={{
            margin: '-32px',
            width: 'calc(100% + 64px)',
            height: 'calc(100vh - var(--header-height))',
            overflow: 'hidden',
        }}>
            <iframe
                ref={iframeRef}
                src="/pro-charts.html"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                title="Pro Charts"
            />
        </div>
    );
}
