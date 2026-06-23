// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
//
// GitHub Pages serves this site at https://xyaman.github.io/yuke-website/.
// When a custom domain is set up, remove the `base` option and update `site`.
export default defineConfig({
	site: 'https://xyaman.github.io',
	base: '/yuke-website',
	integrations: [
		starlight({
			title: 'yuke',
			description: 'A minimal CLI for running LLM agents against any OpenAI-compatible endpoint.',
			favicon: '/favicon.ico',
			customCss: ['./src/styles/custom.css'],
			logo: {
				src: './src/assets/logo.png',
				// The logo's black background is part of the artwork, so we let it
				// ride on both light and dark themes. See logo note in README.
				replacesTitle: false,
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/xyaman/yuke',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/xyaman/yuke-website/edit/main/',
			},
			sidebar: [
				{
					label: 'Start',
					items: [
						{ slug: 'getting-started', label: 'Getting started' },
						{ slug: 'providers', label: 'Provider catalog' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ slug: 'local-mode', label: 'Local mode' },
						{ slug: 'daemon-mode', label: 'Daemon mode' },
						{ slug: 'tui', label: 'yuke-tui' },
						{ slug: 'tui-components', label: 'yuke-tui UI components' },
						{ slug: 'lua-config', label: 'init.lua' },
						{ slug: 'tools', label: 'Writing tools' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ slug: 'cli', label: 'CLI options' },
						{ slug: 'primitives', label: 'Lua primitives' },
						{ slug: 'wire-protocol', label: 'Wire protocol' },
					],
				},
			],
		}),
	],
});
