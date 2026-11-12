sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device"
],
function (JSONModel, Device) {
    "use strict";

    return {
        /**
         * Provides runtime information for the device the UI5 app is running on as a JSONModel.
         * @returns {sap.ui.model.json.JSONModel} The device model.
         */
        createDeviceModel: function () {
            var oModel = new JSONModel(Device);
            oModel.setDefaultBindingMode("OneWay");
            return oModel;
        },

        /**
         * Creates the local view-state model for the diagnostic UI. All
         * presented data is normalized/pre-formatted by the controller; the
         * remote OData model is only read through the service module.
         *
         * @returns {sap.ui.model.json.JSONModel} empty view model
         */
        createViewModel: function () {
            return new JSONModel({
                busy: false,
                canLoad: true,
                hasResults: false,
                strategies: [],
                selectedStrategy: null,
                header: {},
                kpis: [],
                monthly: {},
                results: [],
                selected: {}
            });
        }
    };

});
