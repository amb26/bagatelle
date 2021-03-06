/* eslint-env node */
/* eslint dot-notation: "off"*/
"use strict";

var fluid = require("infusion");

fluid.require("%bagatelle");

var minimist = require("minimist");

require("./dataProcessing/readJSON.js");
require("./dataProcessing/writeJSON.js");
require("./dataProcessing/readCSV.js");
require("./dataProcessing/readCSVwithMap.js");
require("./dataProcessing/writeCSV.js");
require("./dataProcessing/summarise.js");
require("./dataProcessing/coordinatePatch.js");
require("./geom/geoJSON.js");
require("./utils/utils.js");
require("./utils/settleStructure.js");
require("./iNaturalist/iNatUrls.js");

fluid.setLogging(true);
fluid.defeatLogging = true;

var hortis = fluid.registerNamespace("hortis");

hortis.ranks = fluid.freezeRecursive(require("../data/ranks.json"));

var parsedArgs = minimist(process.argv.slice(2));

var taxaMap = hortis.readJSONSync("data/iNaturalist/iNaturalist-taxa-map.json", "reading iNaturalist taxa map file");
var taxonResolveMap = hortis.readJSONSync("data/TaxonResolution-map.json", "reading taxon resolution map");
var swaps = hortis.readJSONSync("data/taxon-swaps.json5", "reading taxon swaps file");
var fusion = hortis.readJSONSync(parsedArgs.fusion);

var discardRanksBelow = "genus"; // TODO: Make this an argument
// var discardRanksBelow = "species";
var discardRanksBelowIndex = hortis.ranks.indexOf(discardRanksBelow);

hortis.combineMaps = function (maps, mutable) {
    var extendArgs = [true, {}].concat(maps);
    var extended = fluid.extend.apply(null, extendArgs);
    return mutable ? extended : fluid.freezeRecursive(extended);
};

hortis.baseCommonOutMap = fluid.freezeRecursive({
    "columns": {
        "iNaturalistTaxonName": "iNaturalist taxon name",
        "iNaturalistTaxonId": "iNaturalist taxon ID"
    }
});

hortis.baseSummariseCommonOutMap = hortis.combineMaps([hortis.baseCommonOutMap, {
    "counts": {
        "observationCount": {
            "column": "observationCount",
            "free": true
        }
    },
    "columns": {
        "observationCount": "Observation count",
        "collection": "Collection/List",
        "coords": "Coordinates"
    }
}]);

hortis.ranksToColumns = function (ranks) {
    return fluid.transform(fluid.arrayToHash(ranks), function (troo, key) {
        return hortis.capitalize(key);
    });
};

hortis.commonOutMap = hortis.combineMaps([hortis.baseCommonOutMap, {
    columns: hortis.ranksToColumns(hortis.ranks)
}]);

hortis.commonObsOutMap = hortis.combineMaps([hortis.commonOutMap, {
    columns: {
        observationId: "observationId",
        latitude: "Latitude",
        longitude: "Longitude"
    }
}]);

hortis.summariseCommonOutMap = hortis.combineMaps([hortis.baseSummariseCommonOutMap, {
    columns: hortis.ranksToColumns(hortis.ranks)
}]);

hortis.invertSwaps = function (swaps) {
    var invertedSwaps = {};
    fluid.each(swaps, function (value, resolvedTaxon) {
        var iNaturalistTaxonId = value.iNaturalistTaxonId;
        if (!iNaturalistTaxonId) {
            fluid.fail("Swap with name " + resolvedTaxon + " does not have iNaturalistTaxonId");
        }
        fluid.each(value.taxonNames, function (record, taxonName) {
            if (record.type !== "commonName") {
                invertedSwaps[taxonName] = iNaturalistTaxonId;
            }
        });
    });
    return invertedSwaps;
};

var invertedSwaps = hortis.invertSwaps(swaps);

hortis.checkFilters = function (filters, mapColumns) {
    fluid.each(filters, function (oneFilter) {
        if (!mapColumns[oneFilter.field]) {
            fluid.fail("Column " + oneFilter.field + " is unknown in input map file");
        }
    });
    return filters || {};
};

hortis.makeObsIdGenerator = function (idField, dataset) {
    if (idField.includes("(")) {
        var parsed = fluid.compactStringToRec(idField, "idGenerator");
        return function (obsRow) {
            var expandArgs = fluid.transform(parsed.args, function (arg) {
                return fluid.stringTemplate(arg, obsRow);
            });
            return fluid.invokeGlobalFunction(parsed.funcName, expandArgs);
        };
    } else { // It must be a simple reference
        return function (obsRow, rowNumber) {
            var terms = fluid.extend({}, obsRow, {rowNumber: rowNumber}, dataset);
            return fluid.stringTemplate(idField, terms);
        };
    }
};

hortis.assignObsIds = function (rows, map, dataset) {
    if (map.observationId) {
        var idGenerator = hortis.makeObsIdGenerator(map.observationId, dataset);
        rows.forEach(function (row, index) {
            var id = map.datasetId + ":" + idGenerator(row, index);
            row.observationId = id;
        });
    }
    rows.forEach(function (row) {
        // TODO: Source this field from hortis.summarise - implies pushing summarise through args all the way back to hortis.fusionToLoadable
        row.collection = map.datasetId;
    });
    return rows;
};

hortis.applyFilters = function (obsRows, filters, filterCount) {
    var origRows = obsRows.length;
    obsRows = obsRows.filter(function (row) {
        var pass = Object.values(filters).reduce(function (pass, filter) {
            var element = row[filter.field];
            var match = element === filter.equals;
            if (match) {
                pass = filter.exclude ? !match : match;
            }
            return pass;
        }, true);
        return pass;
    });
    if (filterCount > 0) {
        console.log("Discarded " + (origRows - obsRows.length) + " rows by applying " + hortis.pluralise(filterCount, "filter"));
    }
    return obsRows;
};

hortis.resolvePaths = function (obj, pathKeys) {
    pathKeys.forEach(function (pathKey) {
        var path = obj[pathKey];
        if (!path) {
            fluid.fail("Dataset record ", obj, " is missing required member " + pathKey);
        }
        obj[pathKey] = fluid.module.resolvePath(path);
    });
};

hortis.oneDatasetToLoadable = function (dataset) {
    hortis.resolvePaths(dataset, ["map", "outMap", "input"]);
    // TODO: Turn this into a component with transform chain elements some day
    var map = hortis.readJSONSync(dataset.map, "reading Observations map file");
    var rawInput = hortis.csvReaderWithMap({
        inputFile: dataset.input,
        mapColumns: map.columns,
        templateMap: true
    }).completionPromise;
    var parsedFilters = hortis.checkFilters(dataset.filters, map.columns);
    return {
        rawInput: rawInput,
        obsRows: fluid.promise.map(rawInput, function (data) {
            var rowsWithId = hortis.assignObsIds(data.rows, map, dataset);
            var filterCount = Object.keys(parsedFilters).length;
            var filteredRows = hortis.applyFilters(rowsWithId, parsedFilters, filterCount);
            if (filterCount > 0) {
                console.log("Pre-filtered observations to list of " + filteredRows.length + " with " + filterCount + " filters");
            }
            return filteredRows;
        }),
        map: map,
        outMap: hortis.readJSONSync(dataset.outMap, "reading Observations output map file")
    };
};

// These are not functions, but they are not components
fluid.defaults("hortis.pipe.CSVInput", {
    gradeNames: "fluid.component",
    loader: "hortis.pipe.loadCSVInputPipe"
});

fluid.defaults("hortis.pipe.JSONInput", {
    gradeNames: "fluid.component",
    loader: "hortis.pipe.loadJSONInputPipe"
});

fluid.defaults("hortis.pipe.contextInput", {
    gradeNames: "fluid.component",
    loader: "hortis.pipe.loadContextInputPipe"
});

hortis.pipe.loadCSVInputPipe = function (patch) {
    hortis.resolvePaths(patch, ["map", "input"]);
    var map = hortis.readJSONSync(patch.map, "reading patch map file");
    var patchData = hortis.csvReaderWithMap({
        inputFile: patch.input,
        mapColumns: map.columns
    }).completionPromise;
    return {
        patchData: patchData,
        map: map
    };
};

hortis.pipe.loadJSONInputPipe = function (patch) {
    hortis.resolvePaths(patch, ["input"]);
    return {
        patchData: hortis.readJSONSync(patch.input)
    };
};

hortis.pipe.loadContextInputPipe = function (patch) {
    hortis.resolvePaths(patch, ["input"]);
    fluid.loadInContext(patch.input, true);
    return {
        patchData: fluid.getGlobalValue(patch.globalName)
    };
};

hortis.onePatchToLoadable = function (patch) {
    var defaults = fluid.defaults(patch.type);
    var loaded = defaults ? fluid.invokeGlobalFunction(defaults.loader, [patch]) : {};
    Object.assign(patch, loaded);
    return patch;
};

hortis.fusionToLoadable = function (fusion, taxaMap) {
    return {
        datasets: fluid.transform(fusion.datasets, function (dataset) {
            return hortis.oneDatasetToLoadable(dataset);
        }),
        patches: fluid.transform(fusion.patches, function (patch) {
            return hortis.onePatchToLoadable(patch);
        }),
        taxa: hortis.csvReaderWithMap({
            inputFile: "data/iNaturalist/iNaturalist-taxa.csv",
            mapColumns: taxaMap.columns
        }).completionPromise
    };
};

hortis.deprivatise = function (resolved) {
    resolved.obsRows.forEach(function (row) {
        row.latitude = row.privateLatitude || row.latitude;
        row.longitude = row.privateLongitude || row.longitude;
    });
};

var dataPromises = hortis.fusionToLoadable(fusion, taxaMap);

hortis.sanitizeSpeciesName = function (name) {
    name = name.trim();
    [" sp.", " spp.", "?", " etc.", " / "].forEach(function (toRemove) {
        var index = name.indexOf(toRemove);
        if (index !== -1) {
            name = name.substring(0, index);
        }
    });
    name = name.replace("�", "ue");
    name = name.replace(/ (\(.*\))/g, "");
    name = name.replace(" ssp.", "");
    name = name.replace(" subsp.", "");
    name = name.replace(" grp.", "");
    name = name.replace(" group", "");
    name = name.replace(" var.", "");
    name = name.replace(" ined.", "");
    name = name.replace(" aff.", "");
    name = name.replace(" agg.", "");
    name = name.replace(" s.lat.", "");
    name = name.replace(" species complex", "");
    name = name.replace(" complex", "");
    name = name.replace(" cf ", " ");
    name = name.replace(" ?", " ");
    name = name.replace(" x ", " × ");
    return name;
};

hortis.resolveTaxa = function (target, taxaById, taxonId, columns) {
    var taxon = taxaById[taxonId];
    while (taxon.parentNameUsageId) {
        if (columns[taxon.taxonRank]) {
            target[taxon.taxonRank] = taxon.scientificName;
        }
        taxon = taxaById[taxon.parentNameUsageId];
    }
};

hortis.blankRow = function (row) {
    return fluid.transform(row, function (/* col */) {
        return "";
    });
};

hortis.doSummarise = function (outrows, outMap, summarise) {
    var that = hortis.summarise({summarise: summarise});
    outrows.forEach(that.storeRow);
    that.destroy();
    if (summarise) {
        fluid.each(that.uniqueRows, function (row) {
            row.coords = row.coords && JSON.stringify(row.coords);
        });
    } else if (Object.keys(that.discardedRows).length) {
        var outDiscards = [];
        console.log("Warning: the following rows were discarded as duplicates:");
        fluid.each(that.discardedRows, function (discardedRows) {
            outDiscards.push.apply(outDiscards, discardedRows);
            outDiscards.push(hortis.blankRow(discardedRows[0]));
        });
        hortis.writeCSV("duplicates.csv", fluid.extend({}, outMap.columns, {
            observationId: "Allocated ID"})
        , outDiscards, fluid.promise());
        console.log(outDiscards.length + " duplicate rows written to duplicates.csv");
    }
    return Object.values(that.uniqueRows);
};

hortis.makeTaxonomiser = function (data, options) {
    var that = {
        options: fluid.extend(true, {}, options),
        taxaHash: {}, // map iNat scientificName to taxon
        taxaById: {},  // map iNat taxonId to taxon
        // Initialised from observations:
        obsIdToTaxon: [],  // Map of obs id to iNat taxon
        undetHash: {}, // Map of taxon name to undetermined taxon
        undetKeys: [], // Keys of undetHash
        discardedTaxa: {} // Map of discarded taxon name to taxon for filtering by identification level
    };
    data.taxa.rows.forEach(function (taxon) {
        that.taxaHash[taxon.scientificName] = taxon;
        that.taxaById[taxon.taxonId] = taxon;
    });
    return that;
};

hortis.isSelfUndetermined = function (name) {
    return !name || name.includes("undetermined") || name.includes("various");
};

// Side-effects: populates that.obsIdToTaxon, that.undetHash, that.undetKeys, that.discardedTaxa
hortis.applyObservations = function (that, obsRows) {
    var identifiedTo = {}; // Two-level hash of {rank, obs index} to obs
    obsRows.forEach(function (obs) {
        var obsId = obs.observationId;
        if (obsId === undefined) {
            fluid.fail("Observation ", obs, " was not assigned an id");
        }
        var san = hortis.sanitizeSpeciesName(obs.taxonName);
        var taxonLevel = "Undetermined";
        if (!hortis.isSelfUndetermined(san)) {
            var invertedId = invertedSwaps[san];
            var taxon = invertedId && that.taxaById[invertedId] || that.taxaHash[san];
            if (taxon) {
                taxonLevel = taxon.taxonRank;
                that.obsIdToTaxon[obsId] = taxon;
            }
        }
        fluid.set(identifiedTo, [taxonLevel, obsId], obs);
    });
    fluid.each(identifiedTo, function (recs, taxonLevel) {
        console.log("Identified " + Object.keys(recs).length + " records to " + taxonLevel);
    });

    var undets = identifiedTo["Undetermined"];

    if (that.options.discardRanksBelowIndex !== -1) {
        hortis.ranks.forEach(function (rank, rankIndex) {
            if (rankIndex < that.options.discardRanksBelowIndex) {
                var toDiscard = identifiedTo[rank];
                if (toDiscard && Object.keys(toDiscard).length) {
                    fluid.each(toDiscard, function (obs, obsId) {
                        var taxon = that.obsIdToTaxon[obsId];
                        fluid.set(that.discardedTaxa, [taxon.scientificName, obsId], obs);
                        delete that.obsIdToTaxon[obsId];
                    });
                }
            }
        });
    }
    fluid.each(that.discardedTaxa, function (obsMap, taxonName) {
        var keys = Object.keys(obsMap);
        console.log("Discarded " + keys.length + " observations for taxon " + taxonName + " which were only identified to rank " + that.taxaHash[taxonName].taxonRank + ":");
        console.log(keys.join(", "));
    });

    fluid.each(undets, function (undet) {
        if (!hortis.isSelfUndetermined(undet.taxonName)) {
            that.undetHash[undet.taxonName] = undet;
        }
    });
    var undetKeys = Object.keys(that.undetHash).sort();
    console.log("\nListing " + undetKeys.length + " undetermined species in observations: \n");
    undetKeys.forEach(function (undetKey) {
        var row = that.undetHash[undetKey];
        console.log(undetKey + (row.observationId ? (": " + row.observationId) : ""));
    });
    console.log();
    that.undetKeys = undetKeys;
};

hortis.resolveObservationTaxa = function (that, observations, outMap) {
    var togo = [];
    observations.forEach(function (row) {
        var taxon = that.obsIdToTaxon[row.observationId];
        if (taxon) {
            var outrow = fluid.copy(row);
            outrow.iNaturalistTaxonName = taxon.scientificName;
            outrow.iNaturalistTaxonId = taxon.taxonId;
            hortis.resolveTaxa(outrow, that.taxaById, taxon.taxonId, outMap.columns);
            togo.push(outrow);
        }
    });
    return togo;
};


hortis.applyPatches = function (resolved, patches) {
    fluid.each(patches, function (patch, key) {
        fluid.invokeGlobalFunction(patch.processor, [resolved, patch, key]);
    });
};

// Summarise really means "Input was obs"
hortis.resolveAndFilter = function (that, observations, filters, outMap, summarise) {
    var resolved = {};
    var outrows = hortis.resolveObservationTaxa(that, observations, outMap);

    resolved.filters = filters || {};
    resolved.filterCount = Object.keys(resolved.filters).length;

    var filtered = hortis.applyFilters(outrows, resolved.filters, resolved.filterCount);

    if (summarise) {
        resolved.obsRows = filtered;
    } else {
        resolved.summarisedRows = filtered;
    }

    return resolved;
};

hortis.writeReintegratedObservations = function (resolved, fileName, outMapFileName) {
    // If we've been asked to summarise, also output obs since we must have input obs. Summarise means "input was obs"
    if (resolved.obsRows) {
        var reintegratedObsFile = hortis.obsifyFilename(fileName);
        hortis.writeCSV(reintegratedObsFile, resolved.combinedObsOutMap.columns, resolved.obsRows, fluid.promise());

        var combinedObsOutMapFilename = hortis.obsifyFilename(outMapFileName);
        hortis.writeJSONSync(combinedObsOutMapFilename, resolved.combinedObsOutMap);
    }
    hortis.writeCSV(fileName, resolved.combinedOutMap.columns, resolved.summarisedRows, fluid.promise());
    hortis.writeJSONSync(outMapFileName, resolved.combinedOutMap);
};

hortis.writeResolutionFile = function (that) {
    var resolutionRows = fluid.transform(that.undetKeys, function (undetKey) {
        return {
            taxonName: undetKey,
            commonName: that.undetHash[undetKey].commonName
        };
    });
    var promise = fluid.promise();
    hortis.writeCSV("taxonResolution.csv", taxonResolveMap.columns, resolutionRows, promise);
};

hortis.obsifyFilename = function (filename) {
    var lastDot = filename.lastIndexOf(".");
    return filename.substring(0, lastDot) + "-obs" + filename.substring(lastDot);
};

hortis.settleStructure(dataPromises).then(function (data) {
    var summarise = parsedArgs.summarise || fusion.summarise;
    var datasets = data.datasets;
    var flatObs = [];
    fluid.each(datasets, function (dataset) {
        flatObs = flatObs.concat(dataset.obsRows);
    });
    console.log("Loaded " + flatObs.length + " observations from " + hortis.pluralise(Object.keys(datasets).length, "dataset") +
        " to match against " + data.taxa.rows.length + " taxa");
    var that = hortis.makeTaxonomiser(data, {
        discardRanksBelowIndex: discardRanksBelowIndex
    });
    hortis.applyObservations(that, flatObs);

    var writeResolutionFile = parsedArgs.writeRes; // TODO: doesn't seem that this is read or modified any more
    if (writeResolutionFile) {
        hortis.writeResolutionFile(that);
    }
    var outMaps = Object.values(fluid.getMembers(datasets, "outMap"));
    var combinedOutMap = hortis.combineMaps([summarise ? hortis.summariseCommonOutMap : hortis.commonOutMap].concat(outMaps).concat({
        counts: fusion.counts
    }), true);
    combinedOutMap.datasets = fusion.datasets;

    var resolved = hortis.resolveAndFilter(that, flatObs, fusion.filters, combinedOutMap, summarise);

    resolved.combinedOutMap = combinedOutMap;
    resolved.combinedObsOutMap = hortis.combineMaps([hortis.commonObsOutMap].concat(outMaps), true);

    if (summarise) {
        hortis.applyPatches(resolved, data.patches);
        resolved.summarisedRows = hortis.doSummarise(resolved.obsRows, combinedOutMap, true);
    }

    var reintegratedFilename = parsedArgs.dry ? "reintegrated.csv" : fluid.module.resolvePath(fusion.output);

    hortis.writeReintegratedObservations(resolved, reintegratedFilename, fusion.combinedOutMap);

}, function (err) {
    fluid.fail("Error loading data", err);
    if (err.stack) {
        console.log(err.stack);
    }
});
