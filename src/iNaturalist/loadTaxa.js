/* eslint-env node */

"use strict";

var fluid = require("infusion");
var hortis = fluid.registerNamespace("hortis");

require("../dataProcessing/readCSV.js");
require("../dataProcessing/readCSVwithMap.js");

fluid.defaults("hortis.iNat.taxa", {
    gradeNames: "fluid.component",
    mapFile: "data/iNaturalist/iNaturalist-taxa-map.json",
    inputFile: "data/iNaturalist/iNaturalist-taxa.csv",
    events: {
        onIndexed: null
    },
    members: {
        taxaMap: "@expand:hortis.readJSONSync({that}.options.mapFile, reading iNaturalist taxa map file)",
        taxaByName: {},
        taxaByNameAndRank: {},
        taxaById: {},
        completionPromise: "@expand:hortis.iNatTaxa.indexTaxa({that}, {taxaReader}.completionPromise)"
    },
    components: {
        taxaReader: {
            type: "hortis.csvReaderWithMap",
            options: {
                mapColumns: "{taxa}.taxaMap.columns",
                inputFile: "{taxa}.options.inputFile"
            }
        }
    },
    listeners: {
        "onCreate.bindCompletion": "hortis.iNat.taxa.bindCompletion"
    }
});

hortis.iNat.taxa.bindCompletion = function (that) {
    // silly function which will be unnecessary once we have FLUID-4883 "latched events"
    that.completionPromise.then(function (index) {
        that.events.onIndexed.fire(index);
    }, function (err) {
        fluid.fail("Error indexing taxa: ", err);
    });
};

hortis.iNat.taxa.index = function (that, taxaPromise) {
    var togo = fluid.promise();
    taxaPromise.then(function (taxaData) {
        taxaData.rows.forEach(function (taxon) {
            that.taxaByName[taxon.scientificName] = taxon;
            that.taxaById[taxon.taxonId] = taxon;
            that.taxaByNameAndRank[taxon.scientificName + "|" + taxon.taxonRank] = taxon;
        });
        togo.resolve({
            taxaByName: that.taxaByName,
            taxaById: that.taxaById
        });
    });
    return togo;
};
