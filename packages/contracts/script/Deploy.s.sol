// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodSeekV1} from "../src/HoodSeekV1.sol";

contract DeployHoodSeek is Script {
    function run() external {
        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address guardian1 = vm.envAddress("GUARDIAN_1");
        address guardian2 = vm.envAddress("GUARDIAN_2");
        address guardian3 = vm.envAddress("GUARDIAN_3");
        uint256 threshold = vm.envUint("THRESHOLD");

        address[] memory guardians = new address[](3);
        guardians[0] = guardian1;
        guardians[1] = guardian2;
        guardians[2] = guardian3;

        vm.startBroadcast();
        HoodSeekV1 token = new HoodSeekV1(
            initialSupply,
            treasury,
            guardians,
            threshold
        );
        vm.stopBroadcast();

        console.log("HoodSeekV1 deployed at:", address(token));
        console.log("Total Supply:", token.totalSupply());
        console.log("Treasury:", token.treasury());
        console.log("Threshold:", token.threshold());
        console.log("Guardian Count:", token.guardianCount());
    }
}
