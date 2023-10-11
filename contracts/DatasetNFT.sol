// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC165Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IDatasetLinkInitializable} from "./interfaces/IDatasetLinkInitializable.sol";
import {IDatasetNFT} from "./interfaces/IDatasetNFT.sol";
import {IFragmentNFT} from "./interfaces/IFragmentNFT.sol";

/**
 * @title DatasetNFT contract
 * @author Data Tunnel
 * @notice This contract mints ERC721 tokens, each representing a unique Dataset integrated into the Data Tunnel Protocol.
 * It enables the configuration of Datasets, including their monetization, and maintains a record of these configurations.
 * @dev Extends IDatasetNFT, ERC721Upgradeable & AccessControlUpgradeable
 */
contract DatasetNFT is IDatasetNFT, ERC721Upgradeable, AccessControlUpgradeable {
  using Strings for uint256;

  string private constant _NAME = "Data Tunnel Dataset";
  string private constant _SYMBOL = "DTDS";

  bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
  bytes32 public constant APPROVED_TOKEN_ROLE = keccak256("APPROVED_TOKEN_ROLE");

  error TOKEN_ID_NOT_EXISTS(uint256 tokenId);
  error NOT_OWNER(uint256 id, address account);
  error BAD_SIGNATURE(bytes32 msgHash, address recoveredSigner);
  error PERCENTAGE_VALUE_INVALID(uint256 maximum, uint256 current);
  error FRAGMENT_IMPLEMENTATION_INVALID(address fragment);
  error FRAGMENT_CREATION_DISABLED();
  error FRAGMENT_INSTANCE_ALREADY_DEPLOYED();
  error FRAGMENT_INSTANCE_NOT_DEPLOYED();
  error FRAGMENT_PROXY_ADDRESS_INVALID();
  error ZERO_ADDRESS();
  error ARRAY_LENGTH_MISMATCH();
  error INVALID_ZERO_MODEL_FEE();

  event ManagersConfigChange(uint256 id);
  event FragmentInstanceDeployment(uint256 id, address instance);

  string public baseURI;
  address private _fragmentProxyAdmin;
  address public fragmentImplementation;
  address public deployerFeeBeneficiary;
  mapping(uint256 id => ManagersConfig config) public configurations;
  mapping(uint256 id => ManagersConfig proxy) public proxies;
  mapping(uint256 id => IFragmentNFT fragment) public fragments;
  mapping(DeployerFeeModel feeModel => uint256 feePercentage) public deployerFeeModelPercentage;
  mapping(uint256 id => DeployerFeeModel feeModel) public deployerFeeModels;

  modifier onlyTokenOwner(uint256 id) {
    if (_ownerOf(id) != _msgSender()) revert NOT_OWNER(id, _msgSender());
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /**
   * @notice Initializes the contract
   * @dev Sets the name & symbol of the token collection, and
   * grants `DEFAULT_ADMIN_ROLE` role to `admin_`.
   * @param admin_ The address to grant `DEFAULT_ADMIN_ROLE` role
   */
  function initialize(address admin_) external initializer {
    if (admin_ == address(0)) revert ZERO_ADDRESS();
    __ERC721_init(_NAME, _SYMBOL);
    _grantRole(DEFAULT_ADMIN_ROLE, admin_);
  }

  /**
   * @notice Sets the `baseURI` for computing `contractURI` and `tokenURI`
   * @dev The base URI is used to compute the contract URI, which, in turn, is used to generate token URIs.
   * Only callable by DatasetNFT ADMIN 
   * @param baseURI_ The Uniform Resource Identifier (URI) to set as the baseURI
   */
  function setBaseURI(string calldata baseURI_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    baseURI = baseURI_;
  }

  /**
   * @notice Retrieves the contract URI for DatasetNFT
   * @return string The URI of the contract
   */
  function contractURI() public view returns (string memory) {
    return _contractURI();
  }

  /**
   * @notice Retrieves the Uniform Resource Identifier (URI) for the `tokenId` Dataset NFT token
   * @dev If `baseURI` is set, it returns the concatenation of `contractURI` and `tokenId`.
   * If `baseURI` is not set, it returns an empty string.
   * @param tokenId The ID of the target Dataset NFT token
   * @return string The requested URI
   */
  function tokenURI(uint256 tokenId) public view override returns (string memory) {
    if (!_exists(tokenId)) revert TOKEN_ID_NOT_EXISTS(tokenId);
    string memory contractURI_ = string.concat(_contractURI(), "/");
    return bytes(_contractURI()).length > 0 ? string.concat(contractURI_, tokenId.toString()) : "";
  }

  /**
   * @notice Returns the `baseURI` used for generating token URIs
   * @return string The base URI
   */
  function _baseURI() internal view override returns (string memory) {
    return baseURI;
  }

  /**
   * @notice Returns the contract URI for DatasetNFT
   * @dev If `baseURI` is set, it returns the concatenation of `baseURI` and `suffix`.
   * If `baseURI` is not set, it returns an empty string.
   * @return string The contract URI
   */
  function _contractURI() internal view returns (string memory) {
    string memory suffix = "datasets";
    string memory base = _baseURI();

    return bytes(base).length > 0 ? string.concat(base, suffix) : "";
  }

  /**
   * @notice Mints a Dataset NFT token to `to`
   * @dev Emits a {Transfer} event
   * @param uuidHashed The keccak256 hash of the off-chain generated UUID for the Dataset
   * @param to Dataset owner
   * @param signature Signature from a DT service confirming creation of Dataset
   * @return uin256 ID of the minted token
   */
  function mint(bytes32 uuidHashed, address to, bytes calldata signature) external returns (uint256) {
    bytes32 msgHash = _mintMessageHash(uuidHashed);
    address signer = ECDSA.recover(msgHash, signature);
    if (!hasRole(SIGNER_ROLE, signer)) revert BAD_SIGNATURE(msgHash, signer);

    uint256 id = uint256(uuidHashed);

    _mint(to, id);

    return id;
  }

  /**
   * @notice Sets and configures the Manager contracts for a specific Dataset NFT
   * @dev Each Dataset NFT token is linked to a unique set of Manager contracts (Distribution, Subscription, Verifier).
   * Only callable by the owner of the Dataset NFT token.
   * Emits a {ManagersConfigChange} event on condition.
   * @param id The ID of the target Dataset NFT token
   * @param config A struct containing the addresses of the Managers' implementation contracts
   */
  function setManagers(uint256 id, ManagersConfig calldata config) external onlyTokenOwner(id) {
    bool changed;
    if (configurations[id].subscriptionManager != config.subscriptionManager) {
      proxies[id].subscriptionManager = _cloneAndInitialize(config.subscriptionManager, id);
      changed = true;
    }
    if (configurations[id].distributionManager != config.distributionManager) {
      proxies[id].distributionManager = _cloneAndInitialize(config.distributionManager, id);
      changed = true;
    }
    if (configurations[id].verifierManager != config.verifierManager) {
      proxies[id].verifierManager = _cloneAndInitialize(config.verifierManager, id);
      changed = true;
    }
    if (changed) {
      configurations[id] = config;
      emit ManagersConfigChange(id);
    }
  }

  /**
   * @notice Sets the fee percentages for the provided Deployer Fee Models
   * @dev Only callable by DatasetNFT ADMIN.
   * Percentages are encoded such that 100% is represented as 1e18.
   * @param models An array of Deployer Fee Models to set percentages for (see `IDatasetNFT.sol`)
   * @param percentages An array of corresponding fee percentages
   */
  function setDeployerFeeModelPercentages(
    DeployerFeeModel[] calldata models,
    uint256[] calldata percentages
  ) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (models.length != percentages.length) revert ARRAY_LENGTH_MISMATCH();
    for (uint256 i; i < models.length; i++) {
      DeployerFeeModel m = models[i];
      if (uint8(m) == 0) revert INVALID_ZERO_MODEL_FEE();
      uint256 p = percentages[i];
      if (p > 1e18) revert PERCENTAGE_VALUE_INVALID(1e18, p);
      deployerFeeModelPercentage[m] = p;
    }
  }

  /**
   * @notice Sets the deployer fee model for a specific Dataset
   * @dev Only callable by DatasetNFT ADMIN
   * @param datasetId The ID of the target Dataset NFT token
   * @param model The Deployer Fee Model to set
   */
  function setDeployerFeeModel(uint256 datasetId, DeployerFeeModel model) external onlyRole(DEFAULT_ADMIN_ROLE) {
    deployerFeeModels[datasetId] = model;
  }

  /**
   * @notice Sets the address of the deployer fee beneficiary
   * @dev Only callable by DatasetNFT ADMIN
   * @param deployerFeeBeneficiary_  The address to set as the beneficiary
   */
  function setDeployerFeeBeneficiary(address deployerFeeBeneficiary_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (deployerFeeBeneficiary_ == address(0)) revert ZERO_ADDRESS();
    deployerFeeBeneficiary = deployerFeeBeneficiary_;
  }

  /**
   * @notice Sets the address of the FragmentProxyAdmin contract
   * @dev The FragmentProxyAdmin is the Admin of the TransparentUpgradeableProxy which is used for deployment
   * of FragmentNFT instances.
   * Only callable by DatasetNFT ADMIN
   * @param fragmentProxyAdmin_ The address to set
   */
  function setFragmentProxyAdminAddress(address fragmentProxyAdmin_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!Address.isContract(fragmentProxyAdmin_)) revert FRAGMENT_PROXY_ADDRESS_INVALID();
    _fragmentProxyAdmin = fragmentProxyAdmin_;
  }

  /**
   * @notice Sets the address of the FragmentNFT implementation contract
   * @dev FragmentNFT is an ERC721 extension enabling on-chain integration of contributions to Datasets
   * Only callable by DatasetNFT ADMIN
   * @param fragmentImplementation_ The address of the FragmentNFT implementation contract
   */
  function setFragmentImplementation(address fragmentImplementation_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (fragmentImplementation_ != address(0) && !Address.isContract(fragmentImplementation_))
      revert FRAGMENT_IMPLEMENTATION_INVALID(fragmentImplementation_);
    fragmentImplementation = fragmentImplementation_;
  }

  /**
   * @notice Deploys a TransparentUpgradeableProxy of the FragmentNFT implementation contract for a specific Dataset
   * @dev Only callable by the owner of the Dataset NFT token.
   * Emits a {FragmentInstanceDeployment} event.
   * @param id The ID of the target Dataset NFT token
   * @return address The address of the deployed FragmentNFT instance
   */
  function deployFragmentInstance(uint256 id) external onlyTokenOwner(id) returns (address) {
    if (fragmentImplementation == address(0)) revert FRAGMENT_CREATION_DISABLED();
    if (address(fragments[id]) != address(0)) revert FRAGMENT_INSTANCE_ALREADY_DEPLOYED();
    IFragmentNFT instance = IFragmentNFT(_deployTransparentProxyAndInitialize(fragmentImplementation, id));
    fragments[id] = instance;
    emit FragmentInstanceDeployment(id, address(instance));
    return address(instance);
  }

  /**
   * @notice Proposes a specific type of contribution for a particular Dataset
   * @param datasetId The ID of the target Dataset NFT token
   * @param to The address of the contributor
   * @param tag The encoded label indicating the type of contribution
   * @param signature Signature from a DT service confirming the proposal request
   */
  function proposeFragment(uint256 datasetId, address to, bytes32 tag, bytes calldata signature) external {
    IFragmentNFT fragmentInstance = fragments[datasetId];
    if (address(fragmentInstance) == address(0)) revert FRAGMENT_INSTANCE_NOT_DEPLOYED();
    fragmentInstance.propose(to, tag, signature);
  }

  /**
   * @notice Proposes multiple contributions for a specific Dataset
   * @param datasetId The ID of the target Dataset NFT token
   * @param owners An array with the respective contributors' addresses
   * @param tags An array with the respective encoded labels indicating the type of the contributions
   * @param signature Signature from a DT service confirming the proposal request
   */
  function proposeManyFragments(
    uint256 datasetId,
    address[] memory owners,
    bytes32[] memory tags,
    bytes calldata signature
  ) external {
    IFragmentNFT fragmentInstance = fragments[datasetId];
    if (address(fragmentInstance) == address(0)) revert FRAGMENT_INSTANCE_NOT_DEPLOYED();
    fragmentInstance.proposeMany(owners, tags, signature);
  }

  /**
   * @notice Checks whether the given account has the `SIGNER_ROLE`
   * @param account The address of the account to check
   * @return bool True if `account` has the role, false if not
   */
  function isSigner(address account) external view returns (bool) {
    return hasRole(SIGNER_ROLE, account);
  }

  /**
   * @notice Checks whether the given token address is approved for payments (subscription fees)
   * @param token The address of the token to check (address(0) for native currency)
   * @return bool True if `token` is approved, false if it is not
   */
  function isApprovedToken(address token) external view returns (bool) {
    return hasRole(APPROVED_TOKEN_ROLE, token);
  }

  /**
   * @notice Retrieves the address of the SubscriptionManager instance that is deployed for a specific Dataset
   * @param id The ID of the target Dataset NFT token
   * @return address The address of the respective SubscriptionManager instance
   */
  function subscriptionManager(uint256 id) external view returns (address) {
    return proxies[id].subscriptionManager;
  }

  /**
   * @notice Retrieves the address of the DistributionManager instance that is deployed for a specific Dataset
   * @param id The ID of the target Dataset NFT token
   * @return address The address of the respective DistributionManager instance
   */
  function distributionManager(uint256 id) external view returns (address) {
    return proxies[id].distributionManager;
  }

  /**
   * @notice Retrieves the address of the VerifierManager instance that is deployed for a specific Dataset
   * @param id The ID of the target Dataset NFT token
   * @return address The address of the respective VerifierManager instance
   */
  function verifierManager(uint256 id) public view returns (address) {
    return proxies[id].verifierManager;
  }

  /**
   * @notice Retrieves the address of the FragmentNFT instance that is deployed for a specific Dataset
   * @param id The ID of the target Dataset NFT token
   * @return address The address of the respective FragmentNFT instance
   */
  function fragmentNFT(uint256 id) external view returns (address) {
    return address(fragments[id]);
  }

  /**
   * @notice Retrieves the deployer fee percentage set for a specific Dataset
   * @dev Percentages are encoded such that 100% is represented as 1e18
   * @param id The ID of the target Dataset NFT token
   * @return uint256 The inquired percentage
   */
  function deployerFeePercentage(uint256 id) external view returns (uint256) {
    DeployerFeeModel m = deployerFeeModels[id];
    return deployerFeeModelPercentage[m];
  }

  /**
   * @notice Checks whether the interface ID provided is supported by this Contract
   * @dev For more information, see `EIP-165`
   * @param interfaceId The interface ID to check
   * @return bool true if it is supported, false if it is not
   */
  function supportsInterface(
    bytes4 interfaceId
  ) public view virtual override(IERC165Upgradeable, ERC721Upgradeable, AccessControlUpgradeable) returns (bool) {
    return interfaceId == type(IDatasetNFT).interfaceId || super.supportsInterface(interfaceId);
  }

  /**
   * @notice Internal function for cloning, and initializing the given implementation contract
   * @dev The deployed proxy (minimal proxy) is linked to the specified Dataset.
   * Only used for cloning the Manager implementation contracts.
   * @param implementation The address of the target implementation contract
   * @param datasetId The ID of the target Dataset NFT token
   * @return proxy The address of the deployed proxy
   */
  function _cloneAndInitialize(address implementation, uint256 datasetId) internal returns (address proxy) {
    if (implementation == address(0)) revert ZERO_ADDRESS();
    proxy = Clones.clone(implementation);
    IDatasetLinkInitializable(proxy).initialize(address(this), datasetId);
  }

  /**
   * @notice Deploys and initializes a TransparentUpgradeableProxy for the `implementation` contract
   * @dev The TransparentUpgradeableProxy is linked to the specified Dataset.
   * The admin of the TransparentUpgradeableProxy is the fragmentProxyAdmin.
   * Only used for deploying FragmentNFT upgradeable instances.
   * @param implementation The address of the implementation contract
   * @param datasetId The ID of the target Dataset NFT token
   * @return proxy The address of the deployed TransparentUpgradeableProxy
   */
  function _deployTransparentProxyAndInitialize(
    address implementation,
    uint256 datasetId
  ) internal returns (address proxy) {
    if (implementation == address(0)) revert ZERO_ADDRESS();
    bytes memory intializePayload = abi.encodeWithSelector(
      IDatasetLinkInitializable.initialize.selector,
      address(this),
      datasetId
    );
    return address(new TransparentUpgradeableProxy(implementation, _fragmentProxyAdmin, intializePayload));
  }

  /**
   * @notice Returns an Ethereum Signed Message hash for minting a Dataset NFT token
   * @dev See `ECDSA.sol`
   * @param uuidHashed The keccak256 hash of the off-chain generated UUID for the Dataset
   * @return bytes32 The generated Ethereum signed message hash
   */
  function _mintMessageHash(bytes32 uuidHashed) private view returns (bytes32) {
    return ECDSA.toEthSignedMessageHash(abi.encodePacked(block.chainid, address(this), uuidHashed));
  }
}
