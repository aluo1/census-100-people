const html = require('bel');
const d3 = require('d3-selection');
const request = require('d3-request');
const force = require('d3-force');
const jankdefer = require('jankdefer');
const label = require('./lib/labeler');
const path = require('d3-path').path;
const Promise = window.Promise || require('promise-polyfill');
const ranger = require('power-ranger')
const scale = require('d3-scale');
const tspans = require('./lib/tspans');
const wordwrap = require('./lib/wordwrap');

const placeholder = document.querySelector('[data-census-100-people-root]');
const dataUrl = placeholder.dataset.data;
const container = placeholder.parentNode;
const root = html`<div class="Census-100"></div>`;

container.replaceChild(root, placeholder);

// Set ABC color scale. Matches measure names with colors
const color = scale.scaleOrdinal(['#3C6998', '#B05154', '#1B7A7D', '#8D4579', '#97593F', '#605487', '#306C3F'])
let currentColor = 'none';

const margin = 10;
const markRadius = 5; // Circle radius
const markMargin = 7;
const rootSelection = d3.select(root)
    .style('background-color', color(currentColor));;
const svgSelection = rootSelection.append('svg');

let groups;
let nodes;
let currentMeasure = 'none';
let currentComparison = 'none';
let circles = svgSelection.selectAll('circle.population');
let groupCircles = svgSelection.selectAll('path.group');
let groupLabels = svgSelection.selectAll('g.group-label');
let width = parseInt(svgSelection.style('width'));
let height = parseInt(svgSelection.style('height'));
let simulationNodes;
let simulationGroups;

const tick = function(options) {
  const {bar} = (options || {});
    circles
        .attr("cx", d => Math.max(margin, Math.min(width - margin, d.x)))
        .attr("cy", d => Math.max(margin, Math.min(height - margin, d.y)));
}

function initSimulations() {
    // Attempt to fix bug where dots clump on load in production site
    width = parseInt(svgSelection.style('width'));
    height = parseInt(svgSelection.style('height'));

    simulationGroups = force.forceSimulation()
        .force('gravity', force.forceCenter(width/2, height/2))
        .force('attract', force.forceManyBody().strength(1010).distanceMin(10))
        .force('repel', force.forceManyBody().strength(-1000).distanceMax(
            Math.min(width, height) - margin * 2 + 90)
            )
        .force('collide', force.forceCollide(75))
        .stop();

    simulationNodes = force.forceSimulation()
        .force('x', force.forceX(d => (d.group && d.group.x) ? d.group.x : width/2).strength(0.05))
        .force('y', force.forceY(d => (d.group && d.group.y) ? d.group.y : height/2).strength(0.05))
        .force('collide', force.forceCollide(markMargin).strength(1))
        .on('tick', tick);
}

const data = new Promise((resolve, reject) => {
    request.csv(dataUrl, (err, json) => {
        if (err) return reject(err);
        resolve(json);
    });
});

function update(e) {

    currentMeasure = (e) ? e.detail.closestMark.el.dataset.measure : currentMeasure;
    currentComparison = (e) ? e.detail.closestMark.el.dataset.comparison : currentComparison;

    // Set color according to measure
    currentColor = (e) ? e.detail.closestMark.el.dataset.measure : currentColor;
    rootSelection.style('background-color', color(currentColor));

    d3.selectAll('.Scrollyteller-content')
        .style('background-color', hexToRgbA(color(currentColor)));


    // Wait until data exists before we actually react to anything here
    data
    .catch(error => {
      console.error('Could not load data', error);
    })
    .then((data) => {

        // New data
        groups = data.filter(d => d.measure === currentMeasure && d.comparison === currentComparison);

        groups.forEach(d => {
            // This is a super rough approximation of circle packing algorithm for which there doesn't appear to be a universal formula for all n between 1 and 100.
            d.r = Math.sqrt((+d.value*(markRadius+markMargin)*35)/Math.PI);

            // For multi-line labels
            d.groupLines = wordwrap(d.group, 10);
        });

        nodes = groups.reduce((newNodes, group) => newNodes.concat(ranger(+group.value, i => {
            let idx = newNodes.length + i;

            if (typeof nodes !== 'undefined' && nodes[idx]) {
                nodes[idx].group = group;
                return nodes[idx];
            }

            return {
                // Random spread of dots on reload
                x: getRandomInCircle(0, window.innerWidth, 0, window.innerHeight).x,
                y: getRandomInCircle(0, window.innerWidth, 0, window.innerHeight).y,
                group: group
            };
        })),[]);

        // Calculate group positions
        simulationGroups.nodes(groups).alpha(1);
        resolveGroupPositions();
        // Basic fix for labels going off top of screen on small mobiles
        groups.forEach(d => d.y+=40); // Account for label height

        // Labels - using tspans to for multi-line labels
        groupLabels = groupLabels.data(groups);
        groupLabels.exit().remove();

        let groupLabelsEnter = groupLabels.enter().append('g').attr('class', 'group-label');
        groupLabelsEnter.append('text');
        groupLabelsEnter.append('path');

        groupLabels = groupLabelsEnter.merge(groupLabels);

        groupLabels.selectAll('tspan').remove();

        tspans.call(groupLabels.select('text'), function (d) {
            return d.groupLines;
        }); 

        // Setup objects for the label positioner to use
        groups.forEach(d => {
            d.label = {
                x: d.x, 
                y: d.y - d.r - 3 - 15 * d.groupLines.length
            };
            d.anchor = {
                x: d.x,
                y: d.y,
                r: d.r + 20 // Label rotation is jittery
            };
        });

        // Measure the text
        groupLabels.select('text').each(function(d) {
            let bbox = this.getBBox();
            d.label.width = bbox.width;
            d.label.height = bbox.height;
            d.label.name = d.group;
        });

        const nsweeps = groups.length * 2;

        // Calculate label positions
        var labels = label()
            .label(groups.map(d => d.label))
            .anchor(groups.map(d => d.anchor))
            .width(width-margin*2)
            .height(height-margin*2)
            .start(nsweeps);

        // Position the text
        groupLabels.select('text')
            .attr('transform', d => `translate(${d.label.x}, ${d.label.y})`);

        // Draw the arc
        groupLabels.select('path')
            .attr('d', d => {
                let ctx = path();
                let rad = Math.atan2(d.label.y-d.y, d.label.x-d.x);
                ctx.arc(d.anchor.x, d.anchor.y, d.r, rad - deg2rad(30), rad + deg2rad(30));
                ctx.moveTo((d.r + 10) * Math.cos(rad) + d.x, (d.r + 10) * Math.sin(rad) + d.y);
                ctx.lineTo((d.r) * Math.cos(rad) + d.x, (d.r) * Math.sin(rad) + d.y)
                return ctx.toString();
            });

        // Add all the 'people'
        circles = circles.data(nodes)
            .enter().append('circle')
                .attr('class', 'population')
                .attr('r', markRadius)
                .attr('cx', d => d.x || d.group.x)
                .attr('cy', d => d.y || d.group.y)
            .merge(circles)

        // Position them
        simulationNodes.nodes(nodes).alpha(1.3).restart();

    });
}

function deg2rad(deg) {
    return deg * Math.PI / 180;
}

function resolveGroupPositions() {
    while (simulationGroups.alpha() > simulationGroups.alphaMin()) {
        simulationGroups.tick();
        // Keep it in the bounds.
        groups.forEach(d => {
            d.x = Math.min(width-margin*2-d.r, Math.max(margin+d.r, d.x));
            d.y = Math.min(height-margin*2-d.r, Math.max(margin+d.r, d.y));
        });
    }
}

function init(){
    initSimulations();

    container.addEventListener('mark', update);

    window.addEventListener('resize', function() {
        width = parseInt(svgSelection.style('width'));
        height = parseInt(svgSelection.style('height'));
        initSimulations();
        update();
    });
    update();
}


// Polyfill for lower than ES2015
Math.hypot = Math.hypot || function() {
  var y = 0;
  var length = arguments.length;

  for (var i = 0; i < length; i++) {
    if (arguments[i] === Infinity || arguments[i] === -Infinity) {
      return Infinity;
    }
    y += arguments[i] * arguments[i];
  }
  return Math.sqrt(y);
};

// For circle initialisation
function getRandomInCircle(xMin, xMax, yMin, yMax) {
    xMin = Math.ceil(xMin);
    yMin = Math.ceil(yMin);
    xMax = Math.floor(xMax);
    yMax = Math.floor(yMax);

    let randomPoint = {
        x: Math.floor(Math.random() * (xMax - xMin + 1)) + xMin,
        y: Math.floor(Math.random() * (yMax - yMin + 1)) + yMin
    };

    let center = {
        x: (xMin + xMax) / 2,
        y: (yMin + yMax / 2)
    };

    let distance = Math.hypot(center.x - randomPoint.x, center.y - randomPoint.y);

    while (distance > (Math.min(xMax - xMin, yMax - yMin)) / 2)  {
        randomPoint = {
            x: Math.floor(Math.random() * (xMax - xMin + 1)) + xMin,
            y: Math.floor(Math.random() * (yMax - yMin + 1)) + yMin
        };
        distance = Math.hypot(center.x - randomPoint.x, center.y - randomPoint.y);
    }

    return randomPoint;
}

function hexToRgbA(hex){ // also adds alpha
    let c;
    if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
        c = hex.substring(1).split('');
        if(c.length== 3){
            c= [c[0], c[0], c[1], c[1], c[2], c[2]];
        }
        c = '0x'+c.join('');
        return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+',0.85)';
    }
    throw new Error('Bad Hex');
}

// Polyfill for IE etc
if (typeof Object.assign != 'function') {
  Object.assign = function(target, varArgs) { // .length of function is 2
    'use strict';
    if (target == null) { // TypeError if undefined or null
      throw new TypeError('Cannot convert undefined or null to object');
    }

    var to = Object(target);

    for (var index = 1; index < arguments.length; index++) {
      var nextSource = arguments[index];

      if (nextSource != null) { // Skip over if undefined or null
        for (var nextKey in nextSource) {
          // Avoid bugs when hasOwnProperty is shadowed
          if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
            to[nextKey] = nextSource[nextKey];
          }
        }
      }
    }
    return to;
  };
}


// Stops dots clogging up the system on reload
jankdefer(init, {
    timeout: 5000,
    threshold: 10,
    debug: false
});