// Literal descriptor fixture only. No Cursor code is included or executed.
C=A.makeMessageType("agent.v1.AgentClientMessage",()=>[]),
S=A.makeMessageType("agent.v1.AgentServerMessage",()=>[]),
Empty=A.makeMessageType("fixture.Empty",()=>[]),
Model=A.makeMessageType("fixture.Model",()=>[{no:1,name:"name",kind:"scalar",T:9},{no:2,name:"client_display_name",kind:"scalar",T:9},{no:3,name:"supports_agent",kind:"scalar",T:8},{no:38,name:"named_model_section_index",kind:"scalar",T:5,opt:!0}]),
Models=A.makeMessageType("aiserver.v1.AvailableModelsResponse",()=>[{no:1,name:"model_names",kind:"scalar",T:9,repeated:!0},{no:2,name:"models",kind:"message",T:Model,repeated:!0}]),
Email=A.makeMessageType("fixture.Email",()=>[{no:1,name:"email",kind:"scalar",T:9}]),
Cpp=A.makeMessageType("fixture.Cpp",()=>[{no:1,name:"is_on",kind:"scalar",T:8},{no:2,name:"should_fetch_rvf_text",kind:"scalar",T:8},{no:3,name:"allows_tab_chunks",kind:"scalar",T:8},{no:4,name:"cpp_url",kind:"scalar",T:9}]),
FileSync=A.makeMessageType("fixture.FileSync",()=>[{no:1,name:"enabled",kind:"scalar",T:8}]),
ModelDetails=A.makeMessageType("fixture.ModelDetails",()=>[{no:1,name:"model_name",kind:"scalar",T:9}]),
Message=A.makeMessageType("fixture.Message",()=>[{no:1,name:"type",kind:"scalar",T:5},{no:2,name:"text",kind:"scalar",T:9}]),
Chat=A.makeMessageType("fixture.Chat",()=>[{no:1,name:"model_details",kind:"message",T:ModelDetails},{no:2,name:"conversation",kind:"message",T:Message,repeated:!0},{no:3,name:"is_agentic",kind:"scalar",T:8}]),
ChatOutput=A.makeMessageType("fixture.ChatOutput",()=>[{no:1,name:"text",kind:"scalar",T:9}]),
ai={typeName:"aiserver.v1.AiService",methods:{models:{name:"AvailableModels",I:Empty,O:Models,kind:K.Unary},cpp:{name:"CppConfig",I:Empty,O:Cpp,kind:K.Unary},chat:{name:"StreamChat",I:Chat,O:ChatOutput,kind:K.ServerStreaming},unsupported:{name:"Unsupported",I:Empty,O:Empty,kind:K.Unary}}};
auth={typeName:"aiserver.v1.AuthService",methods:{email:{name:"GetEmail",I:Empty,O:Email,kind:K.Unary}}};
fs={typeName:"aiserver.v1.FileSyncService",methods:{enabled:{name:"FSIsEnabledForUser",I:Empty,O:FileSync,kind:K.Unary}}};
