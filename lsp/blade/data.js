'use strict';

// Pure data — add new Blade directives here; completions.js picks them up automatically.

const BLADE_SNIPPETS = [
  // Conditionals
  { label: 'if',             detail: 'If block',                       insertText: 'if (${1:condition})\n    $2\n@endif' },
  { label: 'if-else',        detail: 'If / else block',                insertText: 'if (${1:condition})\n    $2\n@else\n    $3\n@endif' },
  { label: 'if-elseif',      detail: 'If / elseif / else block',       insertText: 'if (${1:condition})\n    $2\n@elseif (${3:condition})\n    $4\n@else\n    $5\n@endif' },
  { label: 'elseif',         detail: 'Else-if clause',                  insertText: 'elseif (${1:condition})' },
  { label: 'else',           detail: 'Else clause',                     insertText: 'else' },
  { label: 'endif',          detail: 'End if block',                    insertText: 'endif' },
  { label: 'unless',         detail: 'Unless conditional block',        insertText: 'unless (${1:condition})\n    $2\n@endunless' },
  { label: 'endunless',      detail: 'End unless block',                insertText: 'endunless' },
  { label: 'isset',          detail: 'Check if variable is set',        insertText: 'isset(\\$${1:variable})\n    $2\n@endisset' },
  { label: 'endisset',       detail: 'End isset block',                 insertText: 'endisset' },
  { label: 'empty',          detail: 'Check if variable is empty',      insertText: 'empty(\\$${1:variable})\n    $2\n@endempty' },
  { label: 'endempty',       detail: 'End empty block',                 insertText: 'endempty' },
  // Authentication
  { label: 'auth',           detail: 'Authenticated users block',       insertText: 'auth\n    $1\n@endauth' },
  { label: 'endauth',        detail: 'End auth block',                  insertText: 'endauth' },
  { label: 'guest',          detail: 'Guest (unauthenticated) block',   insertText: 'guest\n    $1\n@endguest' },
  { label: 'endguest',       detail: 'End guest block',                 insertText: 'endguest' },
  // Environment
  { label: 'production',     detail: 'Production environment block',    insertText: 'production\n    $1\n@endproduction' },
  { label: 'endproduction',  detail: 'End production block',            insertText: 'endproduction' },
  { label: 'env',            detail: 'Specific environment block',      insertText: "env('${1:staging}')\n    $2\n@endenv" },
  { label: 'endenv',         detail: 'End env block',                   insertText: 'endenv' },
  // Section / Layout checks
  { label: 'hasSection',     detail: 'Check if section has content',    insertText: "hasSection('${1:section}')\n    $2\n@endif" },
  { label: 'sectionMissing', detail: 'Check if section is missing',     insertText: "sectionMissing('${1:section}')\n    $2\n@endif" },
  { label: 'session',        detail: 'Session value exists block',      insertText: "session('${1:key}')\n    $2\n@endsession" },
  { label: 'endsession',     detail: 'End session block',               insertText: 'endsession' },
  { label: 'context',        detail: 'Context value exists block',      insertText: "context('${1:key}')\n    $2\n@endcontext" },
  { label: 'endcontext',     detail: 'End context block',               insertText: 'endcontext' },
  // Switch
  { label: 'switch',         detail: 'Switch statement',                insertText: 'switch(\\$${1:variable})\n    @case(${2:1})\n        $3\n        @break\n\n    @default\n        $4\n@endswitch' },
  { label: 'case',           detail: 'Case clause in switch',           insertText: 'case(${1:value})' },
  { label: 'default',        detail: 'Default clause in switch',        insertText: 'default' },
  { label: 'endswitch',      detail: 'End switch block',                insertText: 'endswitch' },
  // Loops
  { label: 'for',            detail: 'For loop',                        insertText: 'for (\\$${1:i} = 0; \\$${1:i} < ${2:10}; \\$${1:i}++)\n    $3\n@endfor' },
  { label: 'endfor',         detail: 'End for loop',                    insertText: 'endfor' },
  { label: 'foreach',        detail: 'Foreach loop',                    insertText: 'foreach (\\$${1:items} as \\$${2:item})\n    $3\n@endforeach' },
  { label: 'endforeach',     detail: 'End foreach loop',                insertText: 'endforeach' },
  { label: 'forelse',        detail: 'Forelse loop with empty fallback', insertText: 'forelse (\\$${1:items} as \\$${2:item})\n    $3\n@empty\n    $4\n@endforelse' },
  { label: 'endforelse',     detail: 'End forelse loop',                insertText: 'endforelse' },
  { label: 'while',          detail: 'While loop',                      insertText: 'while (${1:condition})\n    $2\n@endwhile' },
  { label: 'endwhile',       detail: 'End while loop',                  insertText: 'endwhile' },
  { label: 'continue',       detail: 'Skip to next iteration',          insertText: 'continue' },
  { label: 'break',          detail: 'Break out of loop / switch',      insertText: 'break' },
  // Conditional HTML attributes
  { label: 'class',          detail: 'Conditional CSS class list',      insertText: "class([\n    '${1:base-class}',\n    '${2:conditional-class}' => \\$${3:condition},\n])" },
  { label: 'style',          detail: 'Conditional inline CSS styles',   insertText: "style([\n    '${1:property}: ${2:value}',\n    '${3:property}: ${4:value}' => \\$${5:condition},\n])" },
  { label: 'checked',        detail: 'Conditional checked attribute',   insertText: 'checked(${1:condition})' },
  { label: 'selected',       detail: 'Conditional selected attribute',  insertText: 'selected(${1:condition})' },
  { label: 'disabled',       detail: 'Conditional disabled attribute',  insertText: 'disabled(${1:condition})' },
  { label: 'readonly',       detail: 'Conditional readonly attribute',  insertText: 'readonly(${1:condition})' },
  { label: 'required',       detail: 'Conditional required attribute',  insertText: 'required(${1:condition})' },
  // Subview includes
  { label: 'include',         detail: 'Include a subview',                     insertText: "include('${1:view.name}')" },
  { label: 'includeIf',       detail: 'Include a view if it exists',           insertText: "includeIf('${1:view.name}')" },
  { label: 'includeWhen',     detail: 'Include a view when condition is true',  insertText: "includeWhen(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeUnless',   detail: 'Include a view unless condition',        insertText: "includeUnless(\\$${1:condition}, '${2:view.name}')" },
  { label: 'includeFirst',    detail: 'Include first existing view in array',   insertText: "includeFirst(['${1:view.name}', '${2:fallback}'])" },
  { label: 'includeIsolated', detail: 'Include view without parent variables',  insertText: "includeIsolated('${1:view.name}')" },
  { label: 'each',            detail: 'Render a view for each collection item', insertText: "each('${1:view.name}', \\$${2:items}, '${3:item}')" },
  // Once / push-once
  { label: 'once',           detail: 'Execute once per rendering cycle',  insertText: 'once\n    $1\n@endonce' },
  { label: 'endonce',        detail: 'End once block',                    insertText: 'endonce' },
  { label: 'pushOnce',       detail: 'Push to stack once per cycle',      insertText: "pushOnce('${1:scripts}')\n    $2\n@endPushOnce" },
  { label: 'prependOnce',    detail: 'Prepend to stack once per cycle',   insertText: "prependOnce('${1:scripts}')\n    $2\n@endPrependOnce" },
  // Raw PHP
  { label: 'php',            detail: 'Raw PHP block',                     insertText: 'php\n    $1\n@endphp' },
  { label: 'endphp',         detail: 'End PHP block',                     insertText: 'endphp' },
  { label: 'use',            detail: 'Import a PHP class / function',     insertText: "use('${1:App\\\\Models\\\\Model}')" },
  { label: 'verbatim',       detail: 'Output verbatim (no Blade)',         insertText: 'verbatim\n    $1\n@endverbatim' },
  { label: 'endverbatim',    detail: 'End verbatim block',                insertText: 'endverbatim' },
  // Template inheritance
  { label: 'extends',        detail: 'Extend a parent layout',            insertText: "extends('${1:layouts.app}')" },
  { label: 'section',        detail: 'Define a named section',            insertText: "section('${1:content}')\n    $2\n@endsection" },
  { label: 'endsection',     detail: 'End section block',                 insertText: 'endsection' },
  { label: 'show',           detail: 'Define and immediately yield a section', insertText: 'show' },
  { label: 'yield',          detail: 'Yield (output) a section',          insertText: "yield('${1:content}')" },
  { label: 'parent',         detail: 'Include parent section content',    insertText: 'parent' },
  // Stacks
  { label: 'push',           detail: 'Push content to a named stack',     insertText: "push('${1:scripts}')\n    $2\n@endpush" },
  { label: 'endpush',        detail: 'End push block',                    insertText: 'endpush' },
  { label: 'pushIf',         detail: 'Conditionally push to a stack',     insertText: "pushIf(\\$${1:condition}, '${2:scripts}')\n    $3\n@endPushIf" },
  { label: 'prepend',        detail: 'Prepend content to a named stack',  insertText: "prepend('${1:scripts}')\n    $2\n@endprepend" },
  { label: 'endprepend',     detail: 'End prepend block',                 insertText: 'endprepend' },
  { label: 'stack',          detail: 'Render a named stack',              insertText: "stack('${1:scripts}')" },
  { label: 'hasstack',       detail: 'Check if a stack has content',      insertText: "hasstack('${1:scripts}')\n    $2\n@endif" },
  // Forms
  { label: 'csrf',           detail: 'Generate CSRF hidden token field',  insertText: 'csrf' },
  { label: 'method',         detail: 'Spoof HTTP method for HTML forms',  insertText: "method('${1:PUT}')" },
  { label: 'error',          detail: 'Display a validation error',        insertText: "error('${1:field}')\n    $2\n@enderror" },
  { label: 'enderror',       detail: 'End error block',                   insertText: 'enderror' },
  // Components
  { label: 'props',          detail: 'Declare component props',           insertText: "props(['${1:type}' => '${2:info}', '${3:message}'])" },
  { label: 'aware',          detail: 'Access parent component data',      insertText: "aware(['${1:color}' => '${2:gray}'])" },
  // Fragments
  { label: 'fragment',       detail: 'Define a renderable fragment',      insertText: "fragment('${1:user-list}')\n    $2\n@endfragment" },
  { label: 'endfragment',    detail: 'End fragment block',                insertText: 'endfragment' },
  // Service injection
  { label: 'inject',         detail: 'Inject a service from the container', insertText: "inject('${1:metrics}', '${2:App\\\\Services\\\\MetricsService}')" },
];

module.exports = { BLADE_SNIPPETS };
