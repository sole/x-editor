# x-editor

A web component that uses Code Mirror internally.

## Usage

Web Components are not ready yet in all browsers, so the safest bet for now is to just and simply include `platform.js` to polyfill gaps in the platform (get it? get it?), and then you can safely include the element as an HTML import:

````html
<script src="js/platform.js"></script>
<link rel="import" href="x-editor/element.html">
````

And then you can do this in your code:

````html
<x-editor src="mycode.js"></x-editor>
````

Which will hopefully work and the code will be loaded.

Look at the example to see a complete configuration. Sadly you will need to run it over a local server (or a 'real' server) because there is some XMLHttpRequest in action to load files.

Example: TODO.

## Styling

Use CSS.

## API

### Key bindings

TO DO

### Methods

TO DO

### Events

TO DO

## Things that need to be done

* Fill the TO DO gaps.
* Use Vulcanise or something similar to generate a distributable file with only one JavaScript file that registers the element - so it can be used either with HTML imports or with just including such file.
