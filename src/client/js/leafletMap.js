/* global L */

"use strict";

var hortis = fluid.registerNamespace("hortis");

fluid.defaults("hortis.leafletMap", {
    gradeNames: "fluid.viewComponent",
    selectors: {
        datasetControls: ".fld-bagatelle-dataset-controls",
        map: ".fld-bagatelle-map",
        tooltip: ".fld-bagatelle-map-tooltip",
        grid: ".fld-bagatelle-map-grid"
    },
    members: {
        map: "@expand:L.map({that}.dom.map.0, {that}.options.mapOptions)"
    },
    datasets: {},
    model: {
        mapInitialised: "@expand:{that}.events.buildMap.fire()",
        datasetEnabled: "@expand:hortis.datasetEnabledModel({that}.options.datasets)",
        mapBlockTooltipId: null
    },
    events: {
        buildMap: null,
        createDatasetControl: null
    },
    markup: {
        tooltip: "<div class=\"fld-bagatelle-map-tooltip\"></div>",
        grid: "<div class=\"fld-bagatelle-map-grid\"></div>",
        tooltipHeader: "<table>",
        tooltipRow: "<tr><td class=\"fl-taxonDisplay-key\">%key: </td><td class=\"fl-taxonDisplay-value\">%value</td>",
        tooltipFooter: "</table>"
    },
    fitBounds: [[48.865,-123.65],[49.005,-123.25]],
    listeners: {
        "buildMap.fitBounds": "hortis.leafletMap.fitBounds({that}.map, {that}.options.fitBounds)",
        "buildMap.createTooltip": "hortis.leafletMap.createTooltip({that}, {that}.options.markup)"
    },
    modelListeners: {
        drawGrid: {
            path: ["indexVersion", "datasetEnabled"],
            func: "{that}.drawGrid"
        },
        renderDatasetControls: {
            path: ["indexVersion", "datasetEnabled"],
            func: "hortis.renderDatasetControls",
            args: ["{that}", "{that}.options.datasets", "{that}.quantiser.datasets"]
        },
        updateTooltip: {
            path: ["mapBlockTooltipId", "indexVersion", "datasetEnabled"],
            priority: "after:drawGrid",
            excludeSource: "init",
            func: "hortis.leafletMap.updateTooltip",
            args: ["{that}", "{that}.model.mapBlockTooltipId"]
        },
        updateTooltipHighlight: {
            path: "mapBlockTooltipId",
            excludeSource: "init",
            func: "hortis.leafletMap.updateTooltipHighlight",
            args: ["{that}", "{change}.oldValue"]
        }
    },
    invokers: {
        drawGrid: "hortis.leafletMap.drawGrid({that}, {that}.quantiser, {that}.model.datasetEnabled)"
    },
    dynamicComponents: {
        geoJSONLayers: {
            sources: "{that}.options.geoJSONMapLayers",
            type: "hortis.geoJSONMapLayer",
            options: {
                layer: "{source}"
            }
        },
        datasetControls: {
            createOnEvent: "createDatasetControl",
            type: "{arguments}.0",
            options: "{arguments}.1"
        }
    },
    mapOptions: {
        zoomSnap: 0.1
    },
    gridStyle: {
        color: "black",
        weight: 2.0,
        fillOpacity: 1
    },
    heatLow: "#ffffff",
    // heatHigh: "#ff0000",
    components: {
        quantiser: {
            type: "hortis.quantiser",
            options: {
                baseLatitude: "{leafletMap}.options.fitBounds.0.0",
                model: {
                    indexVersion: "{leafletMap}.model.indexVersion"
                }
            }
        }
    }
});


hortis.datasetEnabledModel = function (datasets) {
    return fluid.transform(datasets, function () {
        return true;
    });
};

hortis.intersect = function (target, source) {
    fluid.each(target, function (value, key) {
        if (!(key in source)) {
            delete target[key];
        }
    });
};

hortis.combineDatasets = function (enabledList, quantiserDatasets) {
    var intersect;
    var union = {
        buckets: {},
        byTaxonId: {}
    };
    enabledList.forEach(function (enabled) {
        var dataset = quantiserDatasets[enabled];
        if (!intersect) {
            intersect = {
                buckets: fluid.extend({}, dataset.buckets),
                byTaxonId: fluid.extend({}, dataset.byTaxonId)
            };
        } else {
            hortis.intersect(intersect.buckets, dataset.buckets);
            hortis.intersect(intersect.byTaxonId, dataset.byTaxonId);
        }
        fluid.extend(union.buckets, dataset.buckets);
        fluid.extend(union.byTaxonId, dataset.byTaxonId);
    });
    return {
        intersect: intersect,
        union: union
    };
};

hortis.renderDatasetControls = function (map, datasets, quantiserDatasets) {
    var controls = fluid.queryIoCSelector(map, "hortis.datasetControlBase");
    controls.forEach(function (control) {
        control.destroy();
    });
    map.events.createDatasetControl.fire("hortis.datasetControlHeader");
    fluid.each(datasets, function (dataset, datasetId) {
        map.events.createDatasetControl.fire("hortis.datasetControl", {
            datasetId: datasetId,
            dataset: dataset,
            quantiserDataset: quantiserDatasets[datasetId]
        });
    });
    var enabledList = [];
    // TODO: can't use fluid.transforms.setMembershipToArray because of its onerous requirements, particularly for "options" structure
    fluid.each(map.model.datasetEnabled, function (value, key) {
        if (value) {
            enabledList.push(key);
        }
    });
    var createFooter = function (prefix, dataset) {
        if (prefix) {
            map.quantiser.datasetToSummary(dataset);
        } else {
            dataset.taxaCount = dataset.area = "";
        }
        map.events.createDatasetControl.fire("hortis.datasetControlFooter", fluid.extend({
            text: prefix ? prefix + " of " + enabledList.length + " datasets" : ""
        }, dataset
        ));
    };
    if (enabledList.length > 1) {
        var combinedDatasets = hortis.combineDatasets(enabledList, quantiserDatasets);
        createFooter("Intersection", combinedDatasets.intersect);
        createFooter("Union", combinedDatasets.union);
    } else {
        createFooter("", {});
        createFooter("", {});
    }
};

fluid.defaults("hortis.geoJSONMapLayer", {
    gradeNames: "fluid.component",
    style: {
        color: "black",
        weight: 1.0
    },
    listeners: {
        "onCreate.applyLayer": "hortis.applyGeoJSONMapLayer({that}, {hortis.leafletMap})"
    }
});

hortis.applyGeoJSONMapLayer = function (mapLayer, map) {
    L.geoJSON(mapLayer.options.layer, {
        style: mapLayer.options.style
    }).addTo(map.map);
};

hortis.leafletMap.fitBounds = function (map, fitBounds) {
    if (fitBounds) {
        map.fitBounds(fitBounds);
    }
};

hortis.leafletMap.createTooltip = function (that, markup) {
    var tooltip = $(markup.tooltip).appendTo(that.container);
    tooltip.hide();
    that.map.createPane("hortis-tooltip", tooltip[0]);
    that.map.createPane("hortis-grid");
    that.gridGroup = L.layerGroup({pane: "hortis-grid"}).addTo(that.map);
    var container = that.map.getContainer();
    $(container).on("click", function (event) {
        if (event.target === container) {
            that.applier.change("mapBlockTooltipId", null);
        }
    });
};

hortis.rectFromCorner = function (tl, latres, longres) {
    return [
        [tl[0], tl[1]],
        [tl[0], tl[1] + longres],
        [tl[0] + latres, tl[1] + longres],
        [tl[0] + latres, tl[1]]
    ];
};

fluid.defaults("hortis.datasetControlBase", {
    gradeNames: "fluid.containerRenderingView",
    parentContainer: "{leafletMap}.dom.datasetControls"
});

fluid.defaults("hortis.datasetControlHeader", {
    gradeNames: "hortis.datasetControlBase",
    markup: {
        container: "<tr class=\"fld-bagatelle-dataset-control\">" +
                 "<td fl-bagatelle-dataset-legend-column></td>" +
                 "<td fl-bagatelle-dataset-checkbox-column></td>" +
                 "<td fl-bagatelle-dataset-name-column></td>" +
                 "%extraColumns</tr>",
        cell: "<td class=\"%columnClass\">%text</td>"
    },
    invokers: {
        renderMarkup: "hortis.datasetControl.renderMarkup({that}.options.markup, true)"
    }
});

fluid.defaults("hortis.datasetControl", {
    gradeNames: "hortis.datasetControlBase",
    selectors: {
        legend: ".fld-bagatelle-dataset-legend",
        enable: ".fld-bagatelle-dataset-checkbox",
        name: ".fld-bagatelle-dataset-name"
    },
    model: {
        datasetEnabled: true
    },
    modelRelay: {
        datasetEnabled: {
            target: "datasetEnabled",
            source: {
                context: "hortis.leafletMap",
                segs: ["datasetEnabled", "{that}.options.datasetId"]
            },
            singleTransform: {
                type: "fluid.transforms.identity"
            }
        }
    },
    invokers: {
        renderMarkup: "hortis.datasetControl.renderMarkup({that}.options.markup, false, {that}.options.dataset, {that}.options.quantiserDataset)"
    },
    // dataset, datasetId, quantiserDataset
    markup: {
        container: "<tr class=\"fld-bagatelle-dataset-control\">" +
                 "<td fl-bagatelle-dataset-legend-column><span class=\"fld-bagatelle-dataset-legend\"></span></td>" +
                 "<td fl-bagatelle-dataset-checkbox-column><input class=\"fld-bagatelle-dataset-checkbox\" type=\"checkbox\"/></td>" +
                 "<td fl-bagatelle-dataset-name-column><span class=\"fld-bagatelle-dataset-name\"></span></td>" +
                 "%extraColumns</tr>",
        cell: "<td class=\"%columnClass\">%text</td>"
    },
    listeners: {
        "onCreate.renderDom": "hortis.datasetControl.renderDom"
    }
});

fluid.defaults("hortis.datasetControlFooter", {
    gradeNames: "hortis.datasetControlBase",
    markup: {
        container: "<tr><td></td><td></td><td class=\"fld-bagatelle-dataset-footer\">%text</td><td></td><td>%taxaCount</td><td>%area</td></tr>"
    },
    // text
    invokers: {
        renderMarkup: {
            funcName: "fluid.stringTemplate",
            args: ["{that}.options.markup.container", {
                text: "{that}.options.text",
                taxaCount: "{that}.options.taxaCount",
                area: "{that}.options.area"
            }]
        }
    }
});


hortis.datasetControl.columnNames = {
    totalCount: {
        name: "Obs count",
        clazz: "fl-bagatelle-obs-count-column"
    },
    taxaCount: {
        name: "Richness",
        clazz: "fl-bagatelle-taxa-count-column"
    },
    area: {
        name: "Area (km²)",
        clazz: "fl-bagatelle-area-column"
    }
};

hortis.datasetControl.renderExtraColumns = function (markup, isHeader, dataset, quantiserDataset) {
    var extraColumns = fluid.transform(hortis.datasetControl.columnNames, function (columnInfo, key) {
        return fluid.stringTemplate(markup, {
            columnClass: columnInfo.clazz,
            text: isHeader ? columnInfo.name : quantiserDataset[key]
        });
    });
    return Object.values(extraColumns).join("\n");
};

hortis.datasetControl.renderMarkup = function (markup, isHeader, dataset, quantiserDataset) {
    var extraColumns = hortis.datasetControl.renderExtraColumns(markup.cell, isHeader, dataset, quantiserDataset);
    return fluid.stringTemplate(markup.container, {
        extraColumns: extraColumns
    });
};

hortis.datasetControl.renderDom = function (that) {
    that.locate("legend").css("background-color", that.options.dataset.colour);
    that.locate("name").text(that.options.dataset.name);
    var checkbox = that.locate("enable");
    checkbox.prop("checked", that.model.datasetEnabled);
    checkbox.change(function () {
        var newState = checkbox.prop("checked");
        that.applier.change("datasetEnabled", newState);
    });
};

hortis.leafletMap.tooltipRow = function (map, key, value) {
    return fluid.stringTemplate(map.options.markup.tooltipRow, {key: key, value: value});
};

hortis.leafletMap.renderObsId = function (obsId) {
    var dataset = hortis.datasetIdFromObs(obsId);
    if (dataset === "iNat") {
        var localId = hortis.localIdFromObs(obsId);
        return fluid.stringTemplate("iNaturalist: <a target=\"_blank\" href=\"https://www.inaturalist.org/observations/%obsId\">%obsId</a>", {
            obsId: localId
        });
    } else {
        return obsId;
    }
};

hortis.leafletMap.updateTooltipHighlight = function (map, oldKey) {
    if (oldKey) {
        var oldBucket = map.toPlot[oldKey];
        if (oldBucket) {
            var element = oldBucket.Lpolygon.getElement();
            element.classList.remove("fl-bagatelle-highlightBlock");
        }
    }
};

hortis.leafletMap.updateTooltip = function (map, key) {
    var tooltip = map.locate("tooltip");
    var bucket = map.toPlot[key];
    if (bucket) {
        var text = map.options.markup.tooltipHeader;
        var dumpRow = function (key, value) {
            text += hortis.leafletMap.tooltipRow(map, key, value);
        };
        var c = function (value) {
            return value.toFixed(3);
        };
        dumpRow("Observation Count", bucket.count);
        dumpRow("Species Richness", Object.values(bucket.byTaxonId).length);
        var p = bucket.polygon;
        var lat0 = p[0][0], lat1 = p[2][0];
        var lng0 = p[0][1], lng1 = p[1][1];
        dumpRow("Latitude", c(lat0) + " to " + c(lat1));
        dumpRow("Longitude", c(lng0) + " to " + c(lng1));
        dumpRow("Dimensions", ((lat1 - lat0) * hortis.latitudeLength(lat0)).toFixed(0) + "m x " +
            ((lng1 - lng0) * hortis.longitudeLength(lat0)).toFixed(0) + "m");
        if (bucket.count < 5) {
            var obs = fluid.flatten(Object.values(bucket.byTaxonId));
            var obsString = fluid.transform(obs, hortis.leafletMap.renderObsId).join("<br/>");
            dumpRow("Observations", obsString);
        }
        text += map.options.markup.tooltipFooter;
        tooltip[0].innerHTML = text;
        tooltip.show();
        var element = bucket.Lpolygon.getElement();
        element.classList.add("fl-bagatelle-highlightBlock");
        var parent = element.parentNode;
        parent.insertBefore(element, null);
    } else {
        tooltip.hide();
    }
};

hortis.leafletMap.drawGrid = function (map, quantiser, datasetEnabled) {
    map.gridGroup.clearLayers();

    var latres = quantiser.model.latResolution, longres = quantiser.model.longResolution;
    var heatLow = fluid.colour.hexToArray(map.options.heatLow);
    var toPlot = map.toPlot = {};
    fluid.each(quantiser.datasets, function (dataset, datasetId) {
        if (datasetEnabled[datasetId]) {
            var mapDataset = map.options.datasets[datasetId];
            var heatHigh = fluid.colour.hexToArray(mapDataset.colour);
            fluid.each(dataset.buckets, function (bucket, key) {
                var prop = Math.pow(bucket.count / dataset.maxCount, 0.25);
                var fillColour = fluid.colour.interpolate(prop, heatLow, heatHigh);
                fluid.model.setSimple(toPlot, [key, "colours", datasetId], fillColour);
                var plotBucket = toPlot[key];
                plotBucket.count = plotBucket.count || 0;
                plotBucket.count += bucket.count;
                plotBucket.byTaxonId = fluid.extend({}, plotBucket.byTaxonId, bucket.byTaxonId);
            });
        }
    });
    fluid.each(toPlot, function (bucket, key) {
        var colours = fluid.values(bucket.colours);
        var colour = fluid.colour.average(colours);
        var topLeft = hortis.quantiser.indexToCoord(key, latres, longres);
        bucket.polygon = hortis.rectFromCorner(topLeft, latres, longres);
        bucket.Lpolygon = L.polygon(bucket.polygon, fluid.extend({}, map.options.gridStyle, {
            fillColor: fluid.colour.arrayToString(colour),
            pane: "hortis-grid"
        }));
        map.gridGroup.addLayer(bucket.Lpolygon);
        bucket.Lpolygon.on("mouseover", function () {
            map.applier.change("mapBlockTooltipId", key);
        });
    });
    if (!toPlot[map.model.mapBlockTooltipId]) {
        map.applier.change("mapBlockTooltipId", null);
    }
};

fluid.defaults("hortis.sunburstLoaderWithMap", {
    gradeNames: "hortis.sunburstLoader",
    selectors: {
        mapHolder: ".fld-bagatelle-map-holder"
    },
    events: {
        sunburstLoaded: null
    },
    markupTemplate: "%resourceBase/html/bagatelle-map.html",
    distributeOptions: {
        sunburstLoaded: {
            target: "{that sunburst}.options.listeners.onCreate",
            record: "{hortis.sunburstLoaderWithMap}.events.sunburstLoaded.fire"
        },
        flatTree: {
            target: "{that quantiser}.options.members.flatTree",
            record: "@expand:fluid.identity({sunburst}.flatTree)"
        }
    },
    components: {
        map: {
            type: "hortis.leafletMap",
            container: "{sunburstLoaderWithMap}.dom.mapHolder",
            createOnEvent: "sunburstLoaded",
            options: {
                gradeNames: "hortis.mapWithSunburst"
            }
        }
    }
});

fluid.defaults("hortis.mapLoaderWithoutSunburst", {
    // TODO: Refactor this obvious insanity
    gradeNames: "hortis.sunburstLoaderWithMap",
    markupTemplate: "%resourceBase/html/bagatelle-map-only.html"
});

fluid.defaults("hortis.mapWithSunburst", {
    modelListeners: {
        mapFocusedTooltipToSunburst: {
            path: "{map}.model.mapBlockTooltipId",
            func: "hortis.mapBlockToFocusedTaxa",
            args: ["{change}.value", "{map}", "{sunburst}"]
        }
    },
    datasets: "{sunburst}.viz.datasets",
    geoJSONMapLayers: "{sunburstLoaderWithMap}.options.geoJSONMapLayers"
});

// Can't use modelRelay because of https://issues.fluidproject.org/browse/FLUID-6208
hortis.mapBlockToFocusedTaxa = function (mapBlockTooltipId, map, sunburst) {
    var togo = {};
    if (mapBlockTooltipId) {
        var bucket = map.toPlot[mapBlockTooltipId];
        if (bucket) {
            fluid.each(bucket.byTaxonId, function (obs, taxonId) {
                togo[taxonId] = true;
            });
        }
    }
    var trans = sunburst.applier.initiate();
    trans.change("rowFocus", null, "DELETE");
    trans.change("rowFocus", togo);
    trans.commit();
};

// From https://en.wikipedia.org/wiki/Longitude#Length_of_a_degree_of_longitude
hortis.WGS84a = 6378137;
hortis.WGS84b = 6356752.3142;
hortis.WGS84e2 = (hortis.WGS84a * hortis.WGS84a - hortis.WGS84b * hortis.WGS84b) / (hortis.WGS84a * hortis.WGS84a);

/** Length in metres for a degree of longitude at given latitude **/

hortis.longitudeLength = function (latitude) {
    var latrad = Math.PI * latitude / 180;
    var sinrad = Math.sin(latrad);
    return Math.PI * hortis.WGS84a * Math.cos(latrad) / (180 * Math.sqrt(1 - hortis.WGS84e2 * sinrad * sinrad));
};

/** Length in metres for a degree of latitude at given latitude **/

hortis.latitudeLength = function (latitude) {
    var latrad = Math.PI * latitude / 180;
    var sinrad = Math.sin(latrad);
    return Math.PI * hortis.WGS84a * (1 - hortis.WGS84e2) / (180 * Math.pow(1 - hortis.WGS84e2 * sinrad * sinrad, 1.5));
};

hortis.longToLat = function (lng, lat) {
    var longLength = hortis.longitudeLength(lat);
    var latLength = hortis.latitudeLength(lat);
    return lng * longLength / latLength;
};

fluid.defaults("hortis.quantiser", {
    gradeNames: "fluid.modelComponent",
    baseLatitude: 51,
    model: {
        longResolution: 0.005,
        indexVersion: 0
    },
    modelRelay: {
        latResolution: {
            target: "latResolution",
            singleTransform: {
                type: "fluid.transforms.free",
                args: ["{that}.model.longResolution", "{that}.options.baseLatitude"],
                func: "hortis.longToLat"
            }
        },
        index: {
            target: "indexVersion",
            singleTransform: {
                type: "fluid.transforms.free",
                args: ["{that}", "{that}.model.latResolution"],
                func: "hortis.quantiser.indexTree"
            }
        }
    },
    members: {
        datasets: {
           // hash of datasetId to {maxCount, buckets}
           // where buckets is hash of id to {count, byId}
        }
    },
    events: {
        indexUpdated: null
    },
    invokers: {
        datasetToSummary: "hortis.quantiser.datasetToSummary({that}, {arguments}.0)", // bucket - will be modified
        indexObs: "hortis.quantiser.indexObs({that}, {arguments}.0, {arguments}.1, {arguments}.2)" // coord, obsId, id
    }
});

hortis.quantiser.indexToCoord = function (index, latres, longres) {
    var coords = index.split("|");
    return [coords[0] * latres, coords[1] * longres];
};

hortis.quantiser.coordToIndex = function (coord, latres, longres) {
    var lat = Math.floor(coord[0] / latres);
    var lng = Math.floor(coord[1] / longres);
    return lat + "|" + lng;
};

hortis.datasetIdFromObs = function (obsId) {
    var colpos = obsId.indexOf(":");
    return obsId.substring(0, colpos);
};

hortis.localIdFromObs = function (obsId) {
    var colpos = obsId.indexOf(":");
    return obsId.substring(colpos + 1);
};

hortis.quantiser.indexObs = function (that, coord, obsId, rowId) {
    var coordIndex = hortis.quantiser.coordToIndex(coord, that.model.latResolution, that.model.longResolution);
    var datasetId = hortis.datasetIdFromObs(obsId);
    var dataset = that.datasets[datasetId];
    if (!dataset) {
        that.datasets[datasetId] = dataset = {maxCount: 0, totalCount: 0, buckets: {}, byTaxonId: {}};
    }
    dataset.byTaxonId[rowId] = true;
    dataset.totalCount++;
    var bucket = dataset.buckets[coordIndex];
    if (!bucket) {
        bucket = dataset.buckets[coordIndex] = {count: 0, byTaxonId: {}};
    }
    bucket.count++;
    dataset.maxCount = Math.max(dataset.maxCount, bucket.count);
    var bucketTaxa = bucket.byTaxonId[rowId];
    if (!bucketTaxa) {
        bucketTaxa = bucket.byTaxonId[rowId] = [];
    }
    bucketTaxa.push(obsId);
};

hortis.quantiser.datasetToSummary = function (that, dataset) {
    var squareSide = hortis.latitudeLength(that.options.baseLatitude) * that.model.latResolution;
    var squareArea = squareSide * squareSide / (1000 * 1000);
    dataset.taxaCount = Object.keys(dataset.byTaxonId).length;
    dataset.area = (Object.keys(dataset.buckets).length * squareArea).toFixed(2);
};

hortis.quantiser.indexTree = function (that) {
    that.flatTree.forEach(function (row) {
        if (row.coords) {
            var coords = JSON.parse(row.coords);
            fluid.each(coords, function (coord, obsId) {
                that.indexObs(coord, obsId, row.id);
            });
        }
    });

    fluid.each(that.datasets, that.datasetToSummary);

    return that.model.indexVersion + 1;
};
