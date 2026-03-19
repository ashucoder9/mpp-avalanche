// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {StreamChannel} from "../src/StreamChannel.sol";

/// @notice Deploy StreamChannel (MPP-compatible) to Avalanche C-Chain
/// @dev Usage:
///   forge script script/DeployStreamChannel.s.sol:DeployStreamChannel \
///     --rpc-url $AVAX_RPC_URL \
///     --private-key $DEPLOYER_KEY \
///     --broadcast --verify
contract DeployStreamChannel is Script {
    function run() external {
        vm.startBroadcast();

        StreamChannel channel = new StreamChannel();
        console.log("StreamChannel deployed at:", address(channel));
        console.log("Chain ID:", block.chainid);
        console.log("Domain separator:", vm.toString(channel.domainSeparator()));

        vm.stopBroadcast();
    }
}
