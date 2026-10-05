// PHP delivery of the preview bridge for the Laravel/Filament preview (the PHP
// image has no node, so the bridge proxy cannot run there).

/**
 * auto_prepend_file run by every PHP process in the preview container. It only
 * acts under the built-in web server (`php artisan serve` spawns `php -S`) —
 * composer/artisan CLI runs return immediately. It buffers the response and
 * inlines the bridge (bridge.js next to this file) after <head> (else before
 * </head>, else after <body>) of 2xx text/html responses; JSON (Livewire
 * updates), assets and other types pass untouched. Content-Length/ETag/
 * Content-MD5 are dropped from HTML responses since the body changes.
 * Written with String.raw: no backticks or dollar-brace sequences inside.
 */
export const BRIDGE_INJECT_PHP = String.raw`<?php
// Auto-written by Claudable (preview only): injects the preview bridge. Not part of the project.
if (PHP_SAPI !== 'cli-server' || defined('CLAUDABLE_BRIDGE_PREPENDED')) {
    return;
}
define('CLAUDABLE_BRIDGE_PREPENDED', true);

(static function (): void {
    $bridge = @file_get_contents(__DIR__ . '/bridge.js');
    if (!is_string($bridge) || $bridge === '' || stripos($bridge, '</script') !== false) {
        return;
    }
    $tag = '<script>' . $bridge . '</script>';

    $isHtml = static function (): bool {
        $code = http_response_code();
        if (is_int($code) && ($code < 200 || $code >= 300 || $code === 204)) {
            return false;
        }
        $type = null;
        foreach (headers_list() as $h) {
            if (stripos($h, 'content-type:') === 0) {
                $type = trim(substr($h, 13));
            }
        }
        if ($type === null) {
            $type = (string) ini_get('default_mimetype');
        }
        return stripos($type, 'text/html') === 0;
    };

    $insertPos = static function (string $html): ?int {
        if (preg_match('/<head(?=[\s>\/])[^>]*>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
            return $m[0][1] + strlen($m[0][0]);
        }
        if (preg_match('/<\/head\s*>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
            return $m[0][1];
        }
        if (preg_match('/<body(?=[\s>\/])[^>]*>/i', $html, $m, PREG_OFFSET_CAPTURE)) {
            return $m[0][1] + strlen($m[0][0]);
        }
        return null;
    };

    header_register_callback(static function () use ($isHtml): void {
        if ($isHtml()) {
            header_remove('Content-Length');
            header_remove('ETag');
            header_remove('Content-MD5');
        }
    });

    $state = ['done' => false, 'html' => null, 'buf' => ''];
    ob_start(static function (string $chunk, int $phase) use (&$state, $tag, $isHtml, $insertPos): string {
        if ($state['done']) {
            return $chunk;
        }
        if ($state['html'] === null) {
            $state['html'] = $isHtml();
        }
        if (!$state['html']) {
            $state['done'] = true;
            return $chunk;
        }
        $state['buf'] .= $chunk;
        $buf = $state['buf'];
        $pos = $insertPos($buf);
        if ($pos !== null) {
            $state['done'] = true;
            $state['buf'] = '';
            return substr($buf, 0, $pos) . $tag . substr($buf, $pos);
        }
        if (($phase & PHP_OUTPUT_HANDLER_FINAL) || strlen($buf) > 524288) {
            $state['done'] = true;
            $state['buf'] = '';
            return $buf;
        }
        return '';
    });
})();
`;

/** Directory (inside the bridge mount) holding only the ini fragment — PHP_INI_SCAN_DIR target. */
export const BRIDGE_PHP_INI_DIR = 'php';
export const BRIDGE_PHP_INI_FILE = 'claudable-bridge.ini';

export function bridgePhpIni(mount: string): string {
  return `; Auto-written by Claudable (preview only): preview bridge injection.\nauto_prepend_file=${mount}/inject.php\n`;
}
