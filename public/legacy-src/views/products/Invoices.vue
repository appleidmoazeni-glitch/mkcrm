<template>
  <main :class="['main-content', 'full-height', 'fh-70']">
    <b-overlay :show="loading.items" opacity="0.6" rounded="lg" class="card">
      <form method="post" id="filters">
        <div class="card-header">
          <h5>ثبت فاکتور</h5>
          <div class="items form-inline">
            <input name="search" @keypress.enter.prevent="getOrderItems" type="search" class="form-control just" placeholder="جستجو ..." />
            <button class="btn btn-light mr-2" @click="getOrderItems" type="button"><i class="ti-reload"></i></button>
            <button class="btn btn-light mr-2" @click="updateShygun" type="button"><i class="fa fa-database"></i></button>
            <button class="btn btn-light mr-2" @click="ordersFilter" type="button"><i class="fa fa-filter"></i></button>
          </div>
        </div>
        <div class="bg-secondary-bright pt-2 pb-2" style="display: none" id="ordersFilter">
          <div class="row pr-3 pl-3">
            <div class="col-lg-6 mt-2">
              <div><strong class="m-l-15">وضعیت کالا: </strong></div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="waiting" type="checkbox" class="custom-control-input" id="customSwitchInline1">
                <label class="custom-control-label" for="customSwitchInline1">انتظار</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="unpay" type="checkbox" class="custom-control-input" id="customSwitchInline2">
                <label class="custom-control-label" for="customSwitchInline2">لغو</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="progress" type="checkbox" checked class="custom-control-input" id="customSwitchInline3">
                <label class="custom-control-label" for="customSwitchInline3">پردازش</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="cancel" type="checkbox" class="custom-control-input" id="customSwitchInline4">
                <label class="custom-control-label" for="customSwitchInline4">کنسل</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="factor" type="checkbox" class="custom-control-input" id="customSwitchInline5">
                <label class="custom-control-label" for="customSwitchInline5">تکمیل</label>
              </div>
            </div>
            <div class="col-lg-6 mt-2">
              <div><strong class="m-l-15">وضعیت تامین: </strong></div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="isCost_n" value="1" type="checkbox" checked class="custom-control-input" id="csDelivery1">
                <label class="custom-control-label" for="csDelivery1">خام</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="isCost_y" value="1" type="checkbox" checked class="custom-control-input" id="csDelivery2">
                <label class="custom-control-label" for="csDelivery2">خریده</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="Confirmed_n" value="1" type="checkbox" checked class="custom-control-input" id="csDelivery3">
                <label class="custom-control-label" for="csDelivery3">بدون تایید</label>
              </div>
              <div class="custom-control custom-switch custom-control-inline">
                <input name="Confirmed_y" value="1" type="checkbox" checked class="custom-control-input" id="csDelivery4">
                <label class="custom-control-label" for="csDelivery4">تایید شده</label>
              </div>
            </div>
          </div>

          <input type="hidden" name="sent" value="all">
          <input type="hidden" name="supplier" value="all">
          <!--                    <hr>-->

          <!--                    <div class="row pr-3 pl-3">-->
          <!--                        <div class="form-group col-lg-3">-->
          <!--                            <label>موعد ارسال</label>-->
          <!--                            <select data-module="select2" multiple name="sent" required="" data-toggle="select_all">-->
          <!--                                <option selected value="all">همه</option>-->
          <!--&lt;!&ndash;                                <option :value="new Date().echo('m/d/Y')">{{ new Date().echoFa("j F") }}</option>&ndash;&gt;-->
          <!--                                <option :value="new Date(new Date().getTime() + (d * -86400000)).echo('m/d/Y')" v-for="d in [-7,-6,-5,-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]" value="primary">{{ new Date(new Date().getTime() + (d * 24 * 60 * 60 * 1000 * -1)).echoFa("j F") }}</option>-->
          <!--                            </select>-->
          <!--                        </div>-->
          <!--                        <div class="form-group col-lg-3">-->
          <!--                            <label>تامین کننده</label>-->
          <!--                            <select data-module="select2" multiple name="supplier" required="" data-toggle="select_all">-->
          <!--                                <option value="all">همه</option>-->
          <!--                                <option selected value="7">سایت</option>-->
          <!--                                <option selected value="ygtin">تامین کننده خارجی</option>-->
          <!--                                <option value="ngtin">بدون تامین کننده</option>-->
          <!--                                <option v-for="supp of suppliers" :value="supp.gtin">{{supp.prv}}</option>-->
          <!--                            </select>-->
          <!--                        </div>-->
          <!--                    </div>-->


          <div class="col-12">
            <div class="d-flex flex-row-reverse">
              <button @click="applyFilter" type="button" class="btn btn-primary">اعمال فیلتر</button>
            </div>
          </div>
        </div>
      </form>
      <div class="card-body p-0 table-orders">
        <div class="card-scroll h-100">
          <div class="table-responsive">
            <table :class="['table table-hover', sortBy=='orderNo'?'orderNo':'']" class="table table-hover" width="100%">
              <thead>
              <tr>
                <th @click="sortItems('orderNo')" width="50" :style="sortBy=='orderNo'?'text-decoration: underline;':'cursor: pointer;'">شماره</th>
                <th @click="sortItems('name')" :style="sortBy=='name'?'text-decoration: underline;':'cursor: pointer;'">نام کالا</th>
                <th width="110">ترکیب ویژگی</th>
                <th width="70">تعداد</th>
                <th width="80">خرید</th>
                <th width="80">فروش</th>
                <th @click="sortItems('supplier')" width="90" :style="sortBy=='supplier'?'text-decoration: underline;':'cursor: pointer;'">تامین کننده</th>
                <th width="90">و.کالا</th>
                <th width="70">و.سفارش</th>
                <th width="70">و.فاکتور</th>
                <th width="80">ش.فاکتور</th>
                <th width="50">خریده</th>
                <th width="50">تایید</th>
                <th width="100">یادداشت (کالا)</th>
                <th width="90">تاریخ پرداخت</th>
                <th width="35">موعد</th>
                <th width="35"></th>
              </tr>
              </thead>
              <tbody>
              <tr v-if="orderItems.length == 0"><td colspan="15" class="text-center">-- هیچ کالایی یافت نشد --</td></tr>
              <tr v-for="(item, index) of orderItems" :class="[index>0 && checkDuplicate(index)?'top-g-border':'', item.Gtin==7?'gs-7':'']">
                <td><a v-if="checkDuplicate(index)" :href="'https://mashadkala.com/Admin/Order/Edit/' + item.id" target="_new">{{item.id}}</a></td>
                <td class="latinFont">{{item.name}}</td>
                <td align="center">
                  <span :id="'popover-' + item.oid" v-html="item.AttributeDescription.substring(0, item.AttributeDescription.indexOf('<br')).split(':')[1] || item.AttributeDescription.split(':')[1] || '-'"></span>
                  <b-popover :target="'popover-' + item.oid" triggers="hover"><span v-html="item.AttributeDescription"></span></b-popover>
                </td>
                <td><span class="mr-2">{{item.Quantity}}</span></td>
                <td>{{item.Cost ? number_format(item.Cost) : '-'}}</td>
                <td>{{number_format(item.PriceInclTax)}}</td>
                <td>{{item.prv}}</td>
                <td @click.right.prevent="openSkuEditor(item.ComId)"><i v-if="!item.Sku || (`${item.Sku}||${item.HashAttrs}` != item.CheckedSku)" class="fa fa-exclamation text-danger ml-1"></i>{{item.oiInvStatus}}</td>
                <td><i v-if="checkDuplicate(index)" :class="['fa is-big', orderStatusTitle(item.OrderStatusId).icon]"></i></td>
                <td><template v-if="checkDuplicate(index)">{{item.oInvStatus}}</template></td>
                <td><template v-if="checkDuplicate(index)"><template v-if="item.InvoiceNumber">{{item.InvoiceNumber}}</template><b-button @click="putInvoice(index)" v-else :class="'btn-sm ' + ((item.oInvStatus!='ok'&&item.oInvStatus!='warning')?'btn-light-warning':'')">فاکتور</b-button></template></td>
                <td><i @click="toggleStatus('isCost', index, $event)" :class="['fa is-big btn-status', item.isCost ? 'fa-check text-success' : 'fa-times text-muted']"></i></td>
                <td><i @click="toggleStatus('Confirmed', index, $event)" :class="['fa is-big btn-status', item.Confirmed ? 'fa-check text-success' : 'fa-times text-muted']"></i></td>
                <td><button class="btn btn-sm" data-toggle="modal" :data-index="index" data-target="#setAdminComment">{{item.comment || '-'}}</button></td>
                <td dir="ltr">{{item.PaidDateUtc ? new Date(item.PaidDateUtc).echoFa("m/d - H:i") : "-"}}</td>
                <td>{{item.DeliveryDate ? new Date(item.DeliveryDate).echoFa("m/d") : "-"}}</td>
                <td class="text-left p-0"><b-button v-if="checkDuplicate(index)" class="btn-sm" data-toggle="modal" data-target="#setComment" :data-index="index" variant="link" v-b-popover.hover.right="item.admincomment||''"><i :class="['fa fa-info-circle is-big ml-2', item.admincomment ? 'text-danger' : 'text-muted']"></i></b-button></td>
              </tr>
              </tbody>
            </table>

          </div>
        </div>
      </div>
    </b-overlay>
    <modal-comment :ordersList="orderItems" />
    <div class="modal fade" id="setAdminComment" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">سفارش <span class="text-primary"></span></h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label ml-2">نام کالا:</label>
              <strong id="item-name"></strong>
            </div>
            <div class="form-group">
              <label class="col-form-label">توضیحات کالا:</label>
              <input type="text" class="form-control" name="adminComment" @keypress.enter="sendAdminComment">
            </div>
            <div class="form-group">
              <a href="#" class="btn-tag text-primary ml-2">#کنار</a>
              <a href="#" class="btn-tag text-primary ml-2">#کنسل</a>
              <a href="#" class="btn-tag text-primary ml-2">#کارت</a>
              <a href="#" class="btn-tag text-primary ml-2">#درگاه</a>
              <a href="#" class="btn-tag text-primary ml-2">#نداره</a>
              <a href="#" class="btn-tag text-primary">#فردا</a>
            </div>

          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button type="button" @click="sendAdminComment" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import axios from "axios";
import util from "../../assets/pureFunctions.js";
import querystring from 'querystring';
import ModalComment from "../../components/ModalComment";
export default {
  data(){
    return {
      loading: {items: false, comment: false},
      orderItems: [],
      suppliers: [],
      number_format: util.number_format,
      commentType: 'system',
      sortBy: "orderNo"
    }
  },
  methods: {
    checkDuplicate(index){
      return index==0 || (index>0 && this.orderItems[index-1].id != this.orderItems[index].id);
    },
    ordersFilter(){
      $("#ordersFilter").toggle(300);
    },
    gotoPage(n){
      this.page = n;
    },
    getOrderItems(){
      this.loading.items = true;
      let data = querystring.parse($("#filters").serialize());
      axios.get('/admin/products/orderItem', {params: data}).then(({data}) => {
        this.orderItems = data.items;
        this.suppliers = data.suppliers;
        this.loading.items = false;
      });
    },
    toggleStatus(field, index, e){
      const value = !this.orderItems[index][field];
      e.target.classList = "fa is-big btn-status text-warning " + (value?'fa-check':'fa-times');
      axios.put('/admin/products/orderItem', {field, value, id: this.orderItems[index].oid}).then(({data}) => {
        if( data.ok ){
          this.orderItems[index][field] = value;
        }
      });
    },
    applyFilter(){
      this.getOrderItems();
      $('#ordersFilter').slideUp();
    },
    openSkuEditor(ComId){
      const dualScreenLeft = window.screenLeft !==  undefined ? window.screenLeft : window.screenX;
      const dualScreenTop = window.screenTop !==  undefined   ? window.screenTop  : window.screenY;

      const width = window.innerWidth ? window.innerWidth : document.documentElement.clientWidth ? document.documentElement.clientWidth : screen.width;
      const height = window.innerHeight ? window.innerHeight : document.documentElement.clientHeight ? document.documentElement.clientHeight : screen.height;

      const systemZoom = width / window.screen.availWidth;
      const left = (width - 1000) / 2 / systemZoom + dualScreenLeft
      const top = (height - 700) / 2 / systemZoom + dualScreenTop
      window.open('https://mashadkala.com/Admin/Product/ProductAttributeCombinationEditPopup/'+ComId, 'targetWindow', `toolbar=no,width=1000,height=700,top=${top},left=${left},location=no,status=no,menubar=no,scrollbars=yes,resizable=yes`);
    },
    putInvoice(index){
      this.loading.items = true;
      axios.get('https://shygun.4mk.ir/api/invoices/OrderItems/'+this.orderItems[index].id, {params: {status: this.orderItems[index].oInvStatus}}).then(({data}) => {
        this.loading.items = false;
        if(data && data.ok){
          if( data.invNo ){
            this.orderItems[index].InvoiceNumber = data.invNo;
          }
          toastr['info'](data.msg);
        }else{
          if(data.error == "سفارش سینک نیست"){
            this.updateShygun();
          }
          toastr['error'](data.error);
        }
      });
    },
    updateShygun(){
      this.loading.items = true;
      axios.get('/admin/accounting/syncOrders').then(({data}) => {
        if(data && data.ok){
          toastr['info']("سفارشات با شایگان سینک شدند");
          this.getOrderItems();
        }
        this.loading.items = false;
      });
    },
    sendAdminComment(){
      let el = $("#setAdminComment [name=adminComment]"), value = el.val();
      el.attr('disabled', "disabled");
      axios.put('/admin/products/orderItem', {field: 'admincomment', value, id: this.orderItems[this.activeIndex].oid}).then(({data}) => {
        if( data.ok ){
          toastr['success']("توضیحات با موفقیت درج شد.");
          el.val('');
          $("#setAdminComment").modal('hide');
          el.removeAttr('disabled');
          this.orderItems[this.activeIndex].comment = value;
        }else{
          toastr['error']("خطایی در درج توضیحات رخ داده است.");
        }
      });
    },
    orderStatusTitle(id){
      switch (id){
        case 10: return {title: "انتظار", icon: "fa-money"};
        case 20: return {title: "پردازش", icon: "fa-spinner text-muted"};
        case 30: return {title: "تکمیل", icon: "fa-check text-success"};
        case 40: return {title: "لغو", icon: "fa-times text-danger"};
        default: return {title: "-", icon: ""};
      }
    },
    sortItems(value){
      this.sortBy = value;
      switch (value){
        case "orderNo":
          this.orderItems.sort((a, b) => {
            let nameA = a.id;
            let nameB = b.id;
            if (nameA < nameB) {return 1;}
            if (nameA > nameB) {return -1;}
            return 0;
          });
          break;
        case "name":
          this.orderItems.sort((a, b) => {
            let nameA = a.name.toUpperCase();
            let nameB = b.name.toUpperCase();
            if (nameA < nameB) {return -1;}
            if (nameA > nameB) {return 1;}
            return 0;
          });
          break;
        case "supplier":
          this.orderItems.sort((a, b) => {
            let nameA = a.prv.toUpperCase();
            let nameB = b.prv.toUpperCase();
            if (nameA < nameB) {return -1;}
            if (nameA > nameB) {return 1;}
            return 0;
          });
          break;
      }
    }
  },
  created() {
    const vm = this;
    $(function (){
      vm.getOrderItems();
      $("[name='sent'], [name='supplier']").on('select2:select', function (e){
        var list = $(this).val();
        var lastSelected = e.params.data.id;

        if( lastSelected == "all" ){
          $(this).val('all').trigger('change');
        }else if( (list.indexOf('all') != -1) && list.length > 1 ){
          delete list[list.indexOf('all')];
          $(this).val(list).trigger('change');
        }
      });

      $('#setAdminComment').on('show.bs.modal', function (event) {
        var el = $(event.relatedTarget), modal = $(this), i = el.data('index');
        vm.activeIndex = i;

        modal.find('.modal-title span').text('#'+vm.orderItems[i].id);
        modal.find('#item-name').text(vm.orderItems[i].name);
        modal.find("[name=adminComment]").val(vm.orderItems[i].comment);
        setTimeout(function(){
          modal.find("[name=adminComment]").focus();
        }, 500);
      });
      $('#setAdminComment').on('click', ".btn-tag", function (){
        $('#setAdminComment [name=adminComment]').val( $(this).text().substring(1) );
        return false;
      });
    });

    // let rs = this.resetSearch;
    // document.querySelector("[type=search]")[0].addEventListener("search", function(event) {
    //     rs();
    // });
  },
  components: {
    'modal-comment': ModalComment
  }
}
</script>
<style scoped>
.gs-7 {background-color: #f8f3bb72;}
.gs-7:hover {background-color: #f8f3bb99;}
.gs-ok_ {background-color: #ff9a7472;}
.gs-ok_:hover {background-color: #ff9a7499;}
.gs-7_ {background-color: #abe25272;}
.gs-7_:hover {background-color: #abe25299;}
.latinFont {
  font-family: arial;
}
.orderNo .top-g-border td{border-top: 1px solid #43a9c1 !important;}

.btn-status{cursor: pointer}
.btn-link:hover, .btn-link:focus{text-decoration: none;}
.full-height.fh-69 .card .card-body {height: calc(100vh - 214px);}
.full-height.fh-70 .card .card-body {height: calc(100vh - 155px);}
.items{
  /* margin-top: 10px; */
  position: absolute;
  left: 11px;
  top: 8px;
}
.table-responsive{min-height: 200px}
.table td {
  padding: 4px 0.2rem;
}
@media (max-width: 576px) {
  .items{
    margin-top: 5px; margin-bottom: 10px; position: relative;
  }
  .items [type=search]{width:150px}
  #ordersFilter strong{width:100%; display: block}
}
@media (min-width: 577px) {
  .table td {
    white-space: normal !important;
    line-height: 0.9rem !important;
  }
}
</style>
